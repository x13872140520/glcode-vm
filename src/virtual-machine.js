let _TextEncoder;
if (typeof TextEncoder === 'undefined') {
    _TextEncoder = require('text-encoding').TextEncoder;
} else {
    /* global TextEncoder */
    _TextEncoder = TextEncoder;
}
const EventEmitter = require('events');
const JSZip = require('jszip');

const Buffer = require('buffer').Buffer;
const centralDispatch = require('./dispatch/central-dispatch');
const ExtensionManager = require('./extension-support/extension-manager');
const log = require('./util/log');
const MathUtil = require('./util/math-util');
const Runtime = require('./engine/runtime');
const StringUtil = require('./util/string-util');
const formatMessage = require('format-message');

const Variable = require('./engine/variable');
const newBlockIds = require('./util/new-block-ids');

const {loadCostume} = require('./import/load-costume.js');
const {loadSound} = require('./import/load-sound.js');
const {serializeSounds, serializeCostumes} = require('./serialization/serialize-assets');
const { inRange } = require('lodash');
const { resolve } = require('path');
require('canvas-toBlob');

const RESERVED_NAMES = ['_mouse_', '_stage_', '_edge_', '_myself_', '_random_'];

const CORE_EXTENSIONS = [
    // 'motion',
    // 'looks',
    // 'sound',
    // 'events',
    // 'control',
    // 'sensing',
    // 'operators',
    // 'variables',
    // 'myBlocks'
];

/**
 * Handles connections between blocks, stage, and extensions.
 * @constructor
 */
class VirtualMachine extends EventEmitter {
    constructor () {
        super();

        /**
         * VM runtime, to store blocks, I/O devices, sprites/targets, etc.
         * @type {!Runtime}
         */
        this.runtime = new Runtime();
        centralDispatch.setService('runtime', this.runtime).catch(e => {
            log.error(`Failed to register runtime service: ${JSON.stringify(e)}`);
        });

        /**
         * The "currently editing"/selected target ID for the VM.
         * Block events from any Blockly workspace are routed to this target.
         * @type {Target}
         */
        this.editingTarget = null;

        /**
         * The currently dragging target, for redirecting IO data.
         * @type {Target}
         */
        this._dragTarget = null;

        // Runtime emits are passed along as VM emits.
        this.runtime.on(Runtime.SCRIPT_GLOW_ON, glowData => {
            this.emit(Runtime.SCRIPT_GLOW_ON, glowData);
        });
        this.runtime.on(Runtime.SCRIPT_GLOW_OFF, glowData => {
            this.emit(Runtime.SCRIPT_GLOW_OFF, glowData);
        });
        this.runtime.on(Runtime.BLOCK_GLOW_ON, glowData => {
            this.emit(Runtime.BLOCK_GLOW_ON, glowData);
        });
        this.runtime.on(Runtime.BLOCK_GLOW_OFF, glowData => {
            this.emit(Runtime.BLOCK_GLOW_OFF, glowData);
        });
        this.runtime.on(Runtime.PROJECT_START, () => {
            this.emit(Runtime.PROJECT_START);
        });
        this.runtime.on(Runtime.PROJECT_RUN_START, () => {
            this.emit(Runtime.PROJECT_RUN_START);
        });
        this.runtime.on(Runtime.PROJECT_RUN_STOP, () => {
            this.emit(Runtime.PROJECT_RUN_STOP);
        });
        this.runtime.on(Runtime.PROJECT_CHANGED, () => {
            this.emit(Runtime.PROJECT_CHANGED);
        });
        this.runtime.on(Runtime.VISUAL_REPORT, visualReport => {
            this.emit(Runtime.VISUAL_REPORT, visualReport);
        });
        this.runtime.on(Runtime.TARGETS_UPDATE, emitProjectChanged => {
            this.emitTargetsUpdate(emitProjectChanged);
        });
        this.runtime.on(Runtime.MONITORS_UPDATE, monitorList => {
            this.emit(Runtime.MONITORS_UPDATE, monitorList);
        });
        this.runtime.on(Runtime.BLOCK_DRAG_UPDATE, areBlocksOverGui => {
            this.emit(Runtime.BLOCK_DRAG_UPDATE, areBlocksOverGui);
        });
        this.runtime.on(Runtime.BLOCK_DRAG_END, (blocks, topBlockId) => {
            this.emit(Runtime.BLOCK_DRAG_END, blocks, topBlockId);
        });
        this.runtime.on(Runtime.EXTENSION_ADDED, categoryInfo => {
            this.emit(Runtime.EXTENSION_ADDED, categoryInfo);
        });
        this.runtime.on(Runtime.EXTENSION_FIELD_ADDED, (fieldName, fieldImplementation) => {
            this.emit(Runtime.EXTENSION_FIELD_ADDED, fieldName, fieldImplementation);
        });
        this.runtime.on(Runtime.BLOCKSINFO_UPDATE, categoryInfo => {
            this.emit(Runtime.BLOCKSINFO_UPDATE, categoryInfo);
        });
        this.runtime.on(Runtime.BLOCKS_NEED_UPDATE, () => {
            this.emitWorkspaceUpdate();
        });
        this.runtime.on(Runtime.TOOLBOX_EXTENSIONS_NEED_UPDATE, () => {
            this.extensionManager.refreshBlocks();
        });
        this.runtime.on(Runtime.PERIPHERAL_LIST_UPDATE, info => {
            this.emit(Runtime.PERIPHERAL_LIST_UPDATE, info);
        });
        this.runtime.on(Runtime.USER_PICKED_PERIPHERAL, info => {
            this.emit(Runtime.USER_PICKED_PERIPHERAL, info);
        });
        this.runtime.on(Runtime.PERIPHERAL_CONNECTED, () =>
            this.emit(Runtime.PERIPHERAL_CONNECTED)
        );
        this.runtime.on(Runtime.PERIPHERAL_REQUEST_ERROR, () =>
            this.emit(Runtime.PERIPHERAL_REQUEST_ERROR)
        );
        this.runtime.on(Runtime.PERIPHERAL_DISCONNECTED, () =>
            this.emit(Runtime.PERIPHERAL_DISCONNECTED)
        );
        this.runtime.on(Runtime.PERIPHERAL_CONNECTION_LOST_ERROR, data =>
            this.emit(Runtime.PERIPHERAL_CONNECTION_LOST_ERROR, data)
        );
        this.runtime.on(Runtime.PERIPHERAL_SCAN_TIMEOUT, () =>
            this.emit(Runtime.PERIPHERAL_SCAN_TIMEOUT)
        );
        this.runtime.on(Runtime.MIC_LISTENING, listening => {
            this.emit(Runtime.MIC_LISTENING, listening);
        });
        this.runtime.on(Runtime.RUNTIME_STARTED, () => {
            this.emit(Runtime.RUNTIME_STARTED);
        });
        this.runtime.on(Runtime.HAS_CLOUD_DATA_UPDATE, hasCloudData => {
            this.emit(Runtime.HAS_CLOUD_DATA_UPDATE, hasCloudData);
        });

        this.extensionManager = new ExtensionManager(this.runtime);

        // Load core extensions
        for (const id of CORE_EXTENSIONS) {
            this.extensionManager.loadExtensionIdSync(id);
        }

        this.blockListener = this.blockListener.bind(this);
        this.flyoutBlockListener = this.flyoutBlockListener.bind(this);
        this.monitorBlockListener = this.monitorBlockListener.bind(this);
        this.variableListener = this.variableListener.bind(this);
    }

    /**
     * Start running the VM - do this before anything else.
     */
    start () {
        this.runtime.start();
    }

    /**
     * "Green flag" handler - start all threads starting with a green flag.
     */
    greenFlag () {
        this.runtime.greenFlag();
    }

    /**
     * Set whether the VM is in "turbo mode."
     * When true, loops don't yield to redraw.
     * @param {boolean} turboModeOn Whether turbo mode should be set.
     */
    setTurboMode (turboModeOn) {
        this.runtime.turboMode = !!turboModeOn;
        if (this.runtime.turboMode) {
            this.emit(Runtime.TURBO_MODE_ON);
        } else {
            this.emit(Runtime.TURBO_MODE_OFF);
        }
    }

    /**
     * Set whether the VM is in 2.0 "compatibility mode."
     * When true, ticks go at 2.0 speed (30 TPS).
     * @param {boolean} compatibilityModeOn Whether compatibility mode is set.
     */
    setCompatibilityMode (compatibilityModeOn) {
        this.runtime.setCompatibilityMode(!!compatibilityModeOn);
    }

    /**
     * Stop all threads and running activities.
     */
    stopAll () {
        this.runtime.stopAll();
    }

    /**
     * Clear out current running project data.
     */
    clear () {
        this.runtime.dispose();
        this.editingTarget = null;
        this.emitTargetsUpdate(false /* Don't emit project change */);
    }

    /**
     * Get data for playground. Data comes back in an emitted event.
     */
    getPlaygroundData () {
        const instance = this;
        // Only send back thread data for the current editingTarget.
        const threadData = this.runtime.threads.filter(thread => thread.target === instance.editingTarget);
        // Remove the target key, since it's a circular reference.
        const filteredThreadData = JSON.stringify(threadData, (key, value) => {
            if (key === 'target' || key === 'blockContainer') return;
            return value;
        }, 2);
        this.emit('playgroundData', {
            blocks: this.editingTarget.blocks,
            threads: filteredThreadData
        });
    }

    /**
     * Post I/O data to the virtual devices.
     * @param {?string} device Name of virtual I/O device.
     * @param {object} data Any data object to post to the I/O device.
     */
    postIOData (device, data) {
        if (this.runtime.ioDevices[device]) {
            this.runtime.ioDevices[device].postData(data);
        }
    }

    setVideoProvider (videoProvider) {
        this.runtime.ioDevices.video.setProvider(videoProvider);
    }

    setCloudProvider (cloudProvider) {
        this.runtime.ioDevices.cloud.setProvider(cloudProvider);
    }

    /**
     * Tell the specified extension to scan for a peripheral.
     * @param {string} extensionId - the id of the extension.
     */
    scanForPeripheral (extensionId) {
        this.runtime.scanForPeripheral(extensionId);
    }

    /**
     * Connect to the extension's specified peripheral.
     * @param {string} extensionId - the id of the extension.
     * @param {number} peripheralId - the id of the peripheral.
     */
    connectPeripheral (extensionId, peripheralId) {
        this.runtime.connectPeripheral(extensionId, peripheralId);
    }

    /**
     * Disconnect from the extension's connected peripheral.
     * @param {string} extensionId - the id of the extension.
     */
    disconnectPeripheral (extensionId) {
        this.runtime.disconnectPeripheral(extensionId);
    }

    /**
     * Returns whether the extension has a currently connected peripheral.
     * @param {string} extensionId - the id of the extension.
     * @return {boolean} - whether the extension has a connected peripheral.
     */
    getPeripheralIsConnected (extensionId) {
        return this.runtime.getPeripheralIsConnected(extensionId);
    }

    /**
     * Load a Scratch project from a .sb, .sb2, .sb3 or json string.
     * @param {string | object} input A json string, object, or ArrayBuffer representing the project to load.
     * @return {!Promise} Promise that resolves after targets are installed.
     */
    loadProject (input) {
        if (typeof input === 'object' && !(input instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(input)) {
            // If the input is an object and not any ArrayBuffer
            // or an ArrayBuffer view (this includes all typed arrays and DataViews)
            // turn the object into a JSON string, because we suspect
            // this is a project.json as an object
            // validate expects a string or buffer as input
            // TODO not sure if we need to check that it also isn't a data view
            input = JSON.stringify(input);
        }

        const validationPromise = new Promise((resolve, reject) => {
            const validate = require('scratch-parser');
            // The second argument of false below indicates to the validator that the
            // input should be parsed/validated as an entire project (and not a single sprite)
            validate(input, false, (error, res) => {
                if (error) return reject(error);
                resolve(res);
            });
        })
            .catch(error => {
                const {SB1File, ValidationError} = require('scratch-sb1-converter');

                try {
                    const sb1 = new SB1File(input);
                    const json = sb1.json;
                    json.projectVersion = 2;
                    return Promise.resolve([json, sb1.zip]);
                } catch (sb1Error) {
                    if (sb1Error instanceof ValidationError) {
                        // The input does not validate as a Scratch 1 file.
                    } else {
                        // The project appears to be a Scratch 1 file but it
                        // could not be successfully translated into a Scratch 2
                        // project.
                        return Promise.reject(sb1Error);
                    }
                }
                // Throw original error since the input does not appear to be
                // an SB1File.
                return Promise.reject(error);
            });

        return validationPromise
            .then(validatedInput => this.deserializeProject(validatedInput[0], validatedInput[1]))
            .then(() => this.runtime.emitProjectLoaded())
            .catch(error => {
                // Intentionally rejecting here (want errors to be handled by caller)
                if (error.hasOwnProperty('validationError')) {
                    return Promise.reject(JSON.stringify(error));
                }
                return Promise.reject(error);
            });
    }

    /**
     * Load a project from the Scratch web site, by ID.
     * @param {string} id - the ID of the project to download, as a string.
     */
    downloadProjectId (id) {
        const storage = this.runtime.storage;
        if (!storage) {
            log.error('No storage module present; cannot load project: ', id);
            return;
        }
        const vm = this;
        const promise = storage.load(storage.AssetType.Project, id);
        promise.then(projectAsset => {
            vm.loadProject(projectAsset.data);
        });
    }

    /**
     * @returns {string} Project in a Scratch 3.0 JSON representation.
     */
    saveProjectSb3 () {
        const soundDescs = serializeSounds(this.runtime);
        const costumeDescs = serializeCostumes(this.runtime);
        const projectJson = this.toJSON();

        // TODO want to eventually move zip creation out of here, and perhaps
        // into scratch-storage
        const zip = new JSZip();

        // Put everything in a zip file
        zip.file('project.json', projectJson);
        this._addFileDescsToZip(soundDescs.concat(costumeDescs), zip);

        return zip.generateAsync({
            type: 'blob',
            mimeType: 'application/x.scratch.sb3',
            compression: 'DEFLATE',
            compressionOptions: {
                level: 6 // Tradeoff between best speed (1) and best compression (9)
            }
        });
    }

    /*
     * @type {Array<object>} Array of all costumes and sounds currently in the runtime
     */
    get assets () {
        return this.runtime.targets.reduce((acc, target) => (
            acc
                .concat(target.sprite.sounds.map(sound => sound.asset))
                .concat(target.sprite.costumes.map(costume => costume.asset))
        ), []);
    }

    _addFileDescsToZip (fileDescs, zip) {
        for (let i = 0; i < fileDescs.length; i++) {
            const currFileDesc = fileDescs[i];
            zip.file(currFileDesc.fileName, currFileDesc.fileContent);
        }
    }

    /**
     * Exports a sprite in the sprite3 format.
     * @param {string} targetId ID of the target to export
     * @param {string=} optZipType Optional type that the resulting
     * zip should be outputted in. Options are: base64, binarystring,
     * array, uint8array, arraybuffer, blob, or nodebuffer. Defaults to
     * blob if argument not provided.
     * See https://stuk.github.io/jszip/documentation/api_jszip/generate_async.html#type-option
     * for more information about these options.
     * @return {object} A generated zip of the sprite and its assets in the format
     * specified by optZipType or blob by default.
     */
    exportSprite (targetId, optZipType) {
        const sb3 = require('./serialization/sb3');

        const soundDescs = serializeSounds(this.runtime, targetId);
        const costumeDescs = serializeCostumes(this.runtime, targetId);
        const spriteJson = StringUtil.stringify(sb3.serialize(this.runtime, targetId));

        const zip = new JSZip();
        zip.file('sprite.json', spriteJson);
        this._addFileDescsToZip(soundDescs.concat(costumeDescs), zip);

        return zip.generateAsync({
            type: typeof optZipType === 'string' ? optZipType : 'blob',
            mimeType: 'application/x.scratch.sprite3',
            compression: 'DEFLATE',
            compressionOptions: {
                level: 6
            }
        });
    }

    /**
     * Export project as a Scratch 3.0 JSON representation.
     * @return {string} Serialized state of the runtime.
     */
    toJSON () {
        const sb3 = require('./serialization/sb3');
        return StringUtil.stringify(sb3.serialize(this.runtime));
    }

    // TODO do we still need this function? Keeping it here so as not to introduce
    // a breaking change.
    /**
     * Load a project from a Scratch JSON representation.
     * @param {string} json JSON string representing a project.
     * @returns {Promise} Promise that resolves after the project has loaded
     */
    fromJSON (json) {
        log.warning('fromJSON is now just a wrapper around loadProject, please use that function instead.');
        return this.loadProject(json);
    }

    /**
     * Load a project from a Scratch JSON representation.
     * @param {string} projectJSON JSON string representing a project.
     * @param {?JSZip} zip Optional zipped project containing assets to be loaded.
     * @returns {Promise} Promise that resolves after the project has loaded
     */
    deserializeProject (projectJSON, zip) {
        // Clear the current runtime
        this.clear();

        if (typeof performance !== 'undefined') {
            performance.mark('scratch-vm-deserialize-start');
        }
        const runtime = this.runtime;
        const deserializePromise = function () {
            const projectVersion = projectJSON.projectVersion;
            if (projectVersion === 2) {
                const sb2 = require('./serialization/sb2');
                return sb2.deserialize(projectJSON, runtime, false, zip);
            }
            if (projectVersion === 3) {
                const sb3 = require('./serialization/sb3');
                return sb3.deserialize(projectJSON, runtime, zip);
            }
            return Promise.reject('Unable to verify Scratch Project version.');
        };
        return deserializePromise()
            .then(({targets, extensions}) => {
                if (typeof performance !== 'undefined') {
                    performance.mark('scratch-vm-deserialize-end');
                    performance.measure('scratch-vm-deserialize',
                        'scratch-vm-deserialize-start', 'scratch-vm-deserialize-end');
                }
                return this.installTargets(targets, extensions, true);
            });
    }

    /**
     * Install `deserialize` results: zero or more targets after the extensions (if any) used by those targets.
     * @param {Array.<Target>} targets - the targets to be installed
     * @param {ImportedExtensionsInfo} extensions - metadata about extensions used by these targets
     * @param {boolean} wholeProject - set to true if installing a whole project, as opposed to a single sprite.
     * @returns {Promise} resolved once targets have been installed
     */
    installTargets (targets, extensions, wholeProject) {
        const extensionPromises = [];

        extensions.extensionIDs.forEach(extensionID => {
            if (!this.extensionManager.isExtensionLoaded(extensionID)) {
                const extensionURL = extensions.extensionURLs.get(extensionID) || extensionID;
                extensionPromises.push(this.extensionManager.loadExtensionURL(extensionURL));
            }
        });

        targets = targets.filter(target => !!target);

        return Promise.all(extensionPromises).then(() => {
            targets.forEach(target => {
                this.runtime.addTarget(target);
                (/** @type RenderedTarget */ target).updateAllDrawableProperties();
                // Ensure unique sprite name
                if (target.isSprite()) this.renameSprite(target.id, target.getName());
            });
            // Sort the executable targets by layerOrder.
            // Remove layerOrder property after use.
            this.runtime.executableTargets.sort((a, b) => a.layerOrder - b.layerOrder);
            targets.forEach(target => {
                delete target.layerOrder;
            });

            // Select the first target for editing, e.g., the first sprite.
            if (wholeProject && (targets.length > 1)) {
                this.editingTarget = targets[1];
            } else {
                this.editingTarget = targets[0];
            }

            if (!wholeProject) {
                this.editingTarget.fixUpVariableReferences();
            }

            // Update the VM user's knowledge of targets and blocks on the workspace.
            this.emitTargetsUpdate(false /* Don't emit project change */);
            this.emitWorkspaceUpdate();
            this.runtime.setEditingTarget(this.editingTarget);
            this.runtime.ioDevices.cloud.setStage(this.runtime.getTargetForStage());
        });
    }

    /**
     * Add a sprite, this could be .sprite2 or .sprite3. Unpack and validate
     * such a file first.
     * @param {string | object} input A json string, object, or ArrayBuffer representing the project to load.
     * @return {!Promise} Promise that resolves after targets are installed.
     */
    addSprite (input) {
        const errorPrefix = 'Sprite Upload Error:';
        if (typeof input === 'object' && !(input instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(input)) {
            // If the input is an object and not any ArrayBuffer
            // or an ArrayBuffer view (this includes all typed arrays and DataViews)
            // turn the object into a JSON string, because we suspect
            // this is a project.json as an object
            // validate expects a string or buffer as input
            // TODO not sure if we need to check that it also isn't a data view
            input = JSON.stringify(input);
        }

        const validationPromise = new Promise((resolve, reject) => {
            const validate = require('scratch-parser');
            // The second argument of true below indicates to the parser/validator
            // that the given input should be treated as a single sprite and not
            // an entire project
            validate(input, true, (error, res) => {
                if (error) return reject(error);
                resolve(res);
            });
        });

        return validationPromise
            .then(validatedInput => {
                const projectVersion = validatedInput[0].projectVersion;
                if (projectVersion === 2) {
                    return this._addSprite2(validatedInput[0], validatedInput[1]);
                }
                if (projectVersion === 3) {
                    return this._addSprite3(validatedInput[0], validatedInput[1]);
                }
                return Promise.reject(`${errorPrefix} Unable to verify sprite version.`);
            })
            .then(() => this.runtime.emitProjectChanged())
            .catch(error => {
                // Intentionally rejecting here (want errors to be handled by caller)
                if (error.hasOwnProperty('validationError')) {
                    return Promise.reject(JSON.stringify(error));
                }
                return Promise.reject(`${errorPrefix} ${error}`);
            });
    }

    /**
     * Add a single sprite from the "Sprite2" (i.e., SB2 sprite) format.
     * @param {object} sprite Object representing 2.0 sprite to be added.
     * @param {?ArrayBuffer} zip Optional zip of assets being referenced by json
     * @returns {Promise} Promise that resolves after the sprite is added
     */
    _addSprite2 (sprite, zip) {
        // Validate & parse

        const sb2 = require('./serialization/sb2');
        return sb2.deserialize(sprite, this.runtime, true, zip)
            .then(({targets, extensions}) =>
                this.installTargets(targets, extensions, false));
    }

    /**
     * Add a single sb3 sprite.
     * @param {object} sprite Object rperesenting 3.0 sprite to be added.
     * @param {?ArrayBuffer} zip Optional zip of assets being referenced by target json
     * @returns {Promise} Promise that resolves after the sprite is added
     */
    _addSprite3 (sprite, zip) {
        // Validate & parse
        const sb3 = require('./serialization/sb3');
        return sb3
            .deserialize(sprite, this.runtime, zip, true)
            .then(({targets, extensions}) => this.installTargets(targets, extensions, false));
    }

    /**
     * Add a costume to the current editing target.
     * @param {string} md5ext - the MD5 and extension of the costume to be loaded.
     * @param {!object} costumeObject Object representing the costume.
     * @property {int} skinId - the ID of the costume's render skin, once installed.
     * @property {number} rotationCenterX - the X component of the costume's origin.
     * @property {number} rotationCenterY - the Y component of the costume's origin.
     * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
     * @param {string} optTargetId - the id of the target to add to, if not the editing target.
     * @param {string} optVersion - if this is 2, load costume as sb2, otherwise load costume as sb3.
     * @returns {?Promise} - a promise that resolves when the costume has been added
     */
    addCostume (md5ext, costumeObject, optTargetId, optVersion) {
        const target = optTargetId ? this.runtime.getTargetById(optTargetId) :
            this.editingTarget;
        if (target) {
            return loadCostume(md5ext, costumeObject, this.runtime, optVersion).then(() => {
                target.addCostume(costumeObject);
                target.setCostume(
                    target.getCostumes().length - 1
                );
                this.runtime.emitProjectChanged();
            });
        }
        // If the target cannot be found by id, return a rejected promise
        return Promise.reject();
    }

    /**
     * Add a costume loaded from the library to the current editing target.
     * @param {string} md5ext - the MD5 and extension of the costume to be loaded.
     * @param {!object} costumeObject Object representing the costume.
     * @property {int} skinId - the ID of the costume's render skin, once installed.
     * @property {number} rotationCenterX - the X component of the costume's origin.
     * @property {number} rotationCenterY - the Y component of the costume's origin.
     * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
     * @returns {?Promise} - a promise that resolves when the costume has been added
     */
    addCostumeFromLibrary (md5ext, costumeObject) {
        if (!this.editingTarget) return Promise.reject();
        return this.addCostume(md5ext, costumeObject, this.editingTarget.id, 2 /* optVersion */);
    }

    /**
     * Duplicate the costume at the given index. Add it at that index + 1.
     * @param {!int} costumeIndex Index of costume to duplicate
     * @returns {?Promise} - a promise that resolves when the costume has been decoded and added
     */
    duplicateCostume (costumeIndex) {
        const originalCostume = this.editingTarget.getCostumes()[costumeIndex];
        const clone = Object.assign({}, originalCostume);
        const md5ext = `${clone.assetId}.${clone.dataFormat}`;
        return loadCostume(md5ext, clone, this.runtime).then(() => {
            this.editingTarget.addCostume(clone, costumeIndex + 1);
            this.editingTarget.setCostume(costumeIndex + 1);
            this.emitTargetsUpdate();
        });
    }

    /**
     * Duplicate the sound at the given index. Add it at that index + 1.
     * @param {!int} soundIndex Index of sound to duplicate
     * @returns {?Promise} - a promise that resolves when the sound has been decoded and added
     */
    duplicateSound (soundIndex) {
        const originalSound = this.editingTarget.getSounds()[soundIndex];
        const clone = Object.assign({}, originalSound);
        return loadSound(clone, this.runtime, this.editingTarget.sprite.soundBank).then(() => {
            this.editingTarget.addSound(clone, soundIndex + 1);
            this.emitTargetsUpdate();
        });
    }

    /**
     * Rename a costume on the current editing target.
     * @param {int} costumeIndex - the index of the costume to be renamed.
     * @param {string} newName - the desired new name of the costume (will be modified if already in use).
     */
    renameCostume (costumeIndex, newName) {
        this.editingTarget.renameCostume(costumeIndex, newName);
        this.emitTargetsUpdate();
    }

    /**
     * Delete a costume from the current editing target.
     * @param {int} costumeIndex - the index of the costume to be removed.
     * @return {?function} A function to restore the deleted costume, or null,
     * if no costume was deleted.
     */
    deleteCostume (costumeIndex) {
        const deletedCostume = this.editingTarget.deleteCostume(costumeIndex);
        if (deletedCostume) {
            const target = this.editingTarget;
            this.runtime.emitProjectChanged();
            return () => {
                target.addCostume(deletedCostume);
                this.emitTargetsUpdate();
            };
        }
        return null;
    }

    /**
     * Add a sound to the current editing target.
     * @param {!object} soundObject Object representing the costume.
     * @param {string} optTargetId - the id of the target to add to, if not the editing target.
     * @returns {?Promise} - a promise that resolves when the sound has been decoded and added
     */
    addSound (soundObject, optTargetId) {
        const target = optTargetId ? this.runtime.getTargetById(optTargetId) :
            this.editingTarget;
        if (target) {
            return loadSound(soundObject, this.runtime, target.sprite.soundBank).then(() => {
                target.addSound(soundObject);
                this.emitTargetsUpdate();
            });
        }
        // If the target cannot be found by id, return a rejected promise
        return new Promise.reject();
    }

    /**
     * Rename a sound on the current editing target.
     * @param {int} soundIndex - the index of the sound to be renamed.
     * @param {string} newName - the desired new name of the sound (will be modified if already in use).
     */
    renameSound (soundIndex, newName) {
        this.editingTarget.renameSound(soundIndex, newName);
        this.emitTargetsUpdate();
    }

    /**
     * Get a sound buffer from the audio engine.
     * @param {int} soundIndex - the index of the sound to be got.
     * @return {AudioBuffer} the sound's audio buffer.
     */
    getSoundBuffer (soundIndex) {
        const id = this.editingTarget.sprite.sounds[soundIndex].soundId;
        if (id && this.runtime && this.runtime.audioEngine) {
            return this.editingTarget.sprite.soundBank.getSoundPlayer(id).buffer;
        }
        return null;
    }

    /**
     * Update a sound buffer.
     * @param {int} soundIndex - the index of the sound to be updated.
     * @param {AudioBuffer} newBuffer - new audio buffer for the audio engine.
     * @param {ArrayBuffer} soundEncoding - the new (wav) encoded sound to be stored
     */
    updateSoundBuffer (soundIndex, newBuffer, soundEncoding) {
        const sound = this.editingTarget.sprite.sounds[soundIndex];
        const id = sound ? sound.soundId : null;
        if (id && this.runtime && this.runtime.audioEngine) {
            this.editingTarget.sprite.soundBank.getSoundPlayer(id).buffer = newBuffer;
        }
        // Update sound in runtime
        if (soundEncoding) {
            // Now that we updated the sound, the format should also be updated
            // so that the sound can eventually be decoded the right way.
            // Sounds that were formerly 'adpcm', but were updated in sound editor
            // will not get decoded by the audio engine correctly unless the format
            // is updated as below.
            sound.format = '';
            const storage = this.runtime.storage;
            sound.asset = storage.createAsset(
                storage.AssetType.Sound,
                storage.DataFormat.WAV,
                soundEncoding,
                null,
                true // generate md5
            );
            sound.assetId = sound.asset.assetId;
            sound.dataFormat = storage.DataFormat.WAV;
            sound.md5 = `${sound.assetId}.${sound.dataFormat}`;
            sound.sampleCount = newBuffer.length;
            sound.rate = newBuffer.sampleRate;
        }
        // If soundEncoding is null, it's because gui had a problem
        // encoding the updated sound. We don't want to store anything in this
        // case, and gui should have logged an error.

        this.emitTargetsUpdate();
    }

    /**
     * Delete a sound from the current editing target.
     * @param {int} soundIndex - the index of the sound to be removed.
     * @return {?Function} A function to restore the sound that was deleted,
     * or null, if no sound was deleted.
     */
    deleteSound (soundIndex) {
        const target = this.editingTarget;
        const deletedSound = this.editingTarget.deleteSound(soundIndex);
        if (deletedSound) {
            this.runtime.emitProjectChanged();
            const restoreFun = () => {
                target.addSound(deletedSound);
                this.emitTargetsUpdate();
            };
            return restoreFun;
        }
        return null;
    }

    /**
     * Get a string representation of the image from storage.
     * @param {int} costumeIndex - the index of the costume to be got.
     * @return {string} the costume's SVG string if it's SVG,
     *     a dataURI if it's a PNG or JPG, or null if it couldn't be found or decoded.
     */
    getCostume (costumeIndex) {
        const asset = this.editingTarget.getCostumes()[costumeIndex].asset;
        if (!asset || !this.runtime || !this.runtime.storage) return null;
        const format = asset.dataFormat;
        if (format === this.runtime.storage.DataFormat.SVG) {
            return asset.decodeText();
        } else if (format === this.runtime.storage.DataFormat.PNG ||
                format === this.runtime.storage.DataFormat.JPG) {
            return asset.encodeDataURI();
        }
        log.error(`Unhandled format: ${asset.dataFormat}`);
        return null;
    }

    /**
     * Update a costume with the given bitmap
     * @param {!int} costumeIndex - the index of the costume to be updated.
     * @param {!ImageData} bitmap - new bitmap for the renderer.
     * @param {!number} rotationCenterX x of point about which the costume rotates, relative to its upper left corner
     * @param {!number} rotationCenterY y of point about which the costume rotates, relative to its upper left corner
     * @param {!number} bitmapResolution 1 for bitmaps that have 1 pixel per unit of stage,
     *     2 for double-resolution bitmaps
     */
    updateBitmap (costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution) {
        const costume = this.editingTarget.getCostumes()[costumeIndex];
        if (!(costume && this.runtime && this.runtime.renderer)) return;

        costume.rotationCenterX = rotationCenterX;
        costume.rotationCenterY = rotationCenterY;

        // If the bitmap originally had a zero width or height, use that value
        const bitmapWidth = bitmap.sourceWidth === 0 ? 0 : bitmap.width;
        const bitmapHeight = bitmap.sourceHeight === 0 ? 0 : bitmap.height;
        // @todo: updateBitmapSkin does not take ImageData
        const canvas = document.createElement('canvas');
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
        const context = canvas.getContext('2d');
        context.putImageData(bitmap, 0, 0);

        // Divide by resolution because the renderer's definition of the rotation center
        // is the rotation center divided by the bitmap resolution
        this.runtime.renderer.updateBitmapSkin(
            costume.skinId,
            canvas,
            bitmapResolution,
            [rotationCenterX / bitmapResolution, rotationCenterY / bitmapResolution]
        );

        // @todo there should be a better way to get from ImageData to a decodable storage format
        canvas.toBlob(blob => {
            const reader = new FileReader();
            reader.addEventListener('loadend', () => {
                const storage = this.runtime.storage;
                costume.dataFormat = storage.DataFormat.PNG;
                costume.bitmapResolution = bitmapResolution;
                costume.size = [bitmapWidth, bitmapHeight];
                costume.asset = storage.createAsset(
                    storage.AssetType.ImageBitmap,
                    costume.dataFormat,
                    Buffer.from(reader.result),
                    null, // id
                    true // generate md5
                );
                costume.assetId = costume.asset.assetId;
                costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
                this.emitTargetsUpdate();
            });
            // Bitmaps with a zero width or height return null for their blob
            if (blob){
                reader.readAsArrayBuffer(blob);
            }
        });
    }

    /**
     * Update a costume with the given SVG
     * @param {int} costumeIndex - the index of the costume to be updated.
     * @param {string} svg - new SVG for the renderer.
     * @param {number} rotationCenterX x of point about which the costume rotates, relative to its upper left corner
     * @param {number} rotationCenterY y of point about which the costume rotates, relative to its upper left corner
     */
    updateSvg (costumeIndex, svg, rotationCenterX, rotationCenterY) {
        const costume = this.editingTarget.getCostumes()[costumeIndex];
        if (costume && this.runtime && this.runtime.renderer) {
            costume.rotationCenterX = rotationCenterX;
            costume.rotationCenterY = rotationCenterY;
            this.runtime.renderer.updateSVGSkin(costume.skinId, svg, [rotationCenterX, rotationCenterY]);
            costume.size = this.runtime.renderer.getSkinSize(costume.skinId);
        }
        const storage = this.runtime.storage;
        // If we're in here, we've edited an svg in the vector editor,
        // so the dataFormat should be 'svg'
        costume.dataFormat = storage.DataFormat.SVG;
        costume.bitmapResolution = 1;
        costume.asset = storage.createAsset(
            storage.AssetType.ImageVector,
            costume.dataFormat,
            (new _TextEncoder()).encode(svg),
            null,
            true // generate md5
        );
        costume.assetId = costume.asset.assetId;
        costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
        this.emitTargetsUpdate();
    }

    /**
     * Add a backdrop to the stage.
     * @param {string} md5ext - the MD5 and extension of the backdrop to be loaded.
     * @param {!object} backdropObject Object representing the backdrop.
     * @property {int} skinId - the ID of the backdrop's render skin, once installed.
     * @property {number} rotationCenterX - the X component of the backdrop's origin.
     * @property {number} rotationCenterY - the Y component of the backdrop's origin.
     * @property {number} [bitmapResolution] - the resolution scale for a bitmap backdrop.
     * @returns {?Promise} - a promise that resolves when the backdrop has been added
     */
    addBackdrop (md5ext, backdropObject) {
        return loadCostume(md5ext, backdropObject, this.runtime).then(() => {
            const stage = this.runtime.getTargetForStage();
            stage.addCostume(backdropObject);
            stage.setCostume(stage.getCostumes().length - 1);
            this.runtime.emitProjectChanged();
        });
    }

    /**
     * Rename a sprite.
     * @param {string} targetId ID of a target whose sprite to rename.
     * @param {string} newName New name of the sprite.
     */
    renameSprite (targetId, newName) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            if (!target.isSprite()) {
                throw new Error('Cannot rename non-sprite targets.');
            }
            const sprite = target.sprite;
            if (!sprite) {
                throw new Error('No sprite associated with this target.');
            }
            if (newName && RESERVED_NAMES.indexOf(newName) === -1) {
                const names = this.runtime.targets
                    .filter(runtimeTarget => runtimeTarget.isSprite() && runtimeTarget.id !== target.id)
                    .map(runtimeTarget => runtimeTarget.sprite.name);
                const oldName = sprite.name;
                const newUnusedName = StringUtil.unusedName(newName, names);
                sprite.name = newUnusedName;
                // const allTargets = this.runtime.targets;
                // for (let i = 0; i < allTargets.length; i++) {
                //     const currTarget = allTargets[i];
                //       .blocks.updateAssetName(oldName, newName, 'sprite');
                // }

                if (newUnusedName !== oldName) this.emitTargetsUpdate();
            }
        } else {
            throw new Error('No target with the provided id.');
        }
    }
     /**
     * Rename a groupName of sprites.
     * @param {string} newName input value of group rename 
     * @param {string} groupId groupId of the sprites in a same group.
     */
      renameGroupOfSprites (newName, groupId) {
        let targets = this.runtime.targets;
        targets.map((v)=>{
            if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===groupId){
                v.sprite.customField.groupName=newName
            }
        })
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    /**
     * Rename a groupName of sprites.
     * @param {bool} status current group is editing ?
     * @param {string} groupId groupId of the sprites in a same group.
     */
     onToggleIsEditByGroupId (status, groupId) {
        let targets = this.runtime.targets;
        targets.map((v)=>{
            if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===groupId){
                v.sprite.customField.groupIsEdit=status
            }
        })
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    /**
     * Rename a groupName of sprites.
     * @param {bool} status current group is open ?
     * @param {string} groupId groupId of the sprites in a same group.
     */
     onToggleIsOpenByGroupId (status, groupId) {
        let targets = this.runtime.targets;
        targets.map((v)=>{
            if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===groupId){
                v.sprite.customField.groupOpen=status
            }
        })
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    /**
     * add a group for a sprite.
     * @param {string} targetId ID of a target whose sprite to add.
     */
    addGroupToSprite (targetId,order) {
    const target = this.runtime.getTargetById(targetId);
    if (target) {
        if (!target.isSprite()) {
            throw new Error('Cannot create group for non-sprite targets.');
        }
        const sprite = target.sprite;
        if (!sprite) {
            throw new Error('No sprite associated with this target.');
        }
        if (sprite.groupIndex==null) {
            sprite.customField={
                groupId:targetId+'g',
                groupName:sprite.name+'组',
                groupIndex:order,
                groupOpen:true,
                spriteIndexInGroup:0,
                groupIsEdit:false
            }
            this.emitTargetsUpdate();
        }
        else {
        throw new Error('已经有分组了');
        }
    }
    }
    /**
     * Delete a sprite and all its clones.
     * @param {string} targetId ID of a target whose sprite to delete.
     * @return {Function} Returns a function to restore the sprite that was deleted
     */
    deleteSprite (targetId) {
        const target = this.runtime.getTargetById(targetId);

        if (target) {
            const targetIndexBeforeDelete = this.runtime.targets.map(t => t.id).indexOf(target.id);
            if (!target.isSprite()) {
                throw new Error('Cannot delete non-sprite targets.');
            }
            const sprite = target.sprite;
            if (!sprite) {
                throw new Error('No sprite associated with this target.');
            }
            const spritePromise = this.exportSprite(targetId, 'uint8array');
            const restoreSprite = () => spritePromise.then(spriteBuffer => this.addSprite(spriteBuffer));
            // Remove monitors from the runtime state and remove the
            // target-specific monitored blocks (e.g. local variables)
            target.deleteMonitors();
            const currentEditingTarget = this.editingTarget;
            for (let i = 0; i < sprite.clones.length; i++) {
                const clone = sprite.clones[i];
                this.runtime.stopForTarget(sprite.clones[i]);
                this.runtime.disposeTarget(sprite.clones[i]);
                // Ensure editing target is switched if we are deleting it.
                if (clone === currentEditingTarget) {
                    const nextTargetIndex = Math.min(this.runtime.targets.length - 1, targetIndexBeforeDelete);
                    if (this.runtime.targets.length > 0){
                        this.setEditingTarget(this.runtime.targets[nextTargetIndex].id);
                    } else {
                        this.editingTarget = null;
                    }
                }
            }
            // Sprite object should be deleted by GC.
            this.emitTargetsUpdate();
            return restoreSprite;
        }

        throw new Error('No target with the provided id.');
    }

    /**
     * Duplicate a sprite.
     * @param {string} targetId ID of a target whose sprite to duplicate.
     * @returns {Promise} Promise that resolves when duplicated target has
     *     been added to the runtime.
     */
    duplicateSprite (targetId) {
        const target = this.runtime.getTargetById(targetId);
        if (!target) {
            throw new Error('No target with the provided id.');
        } else if (!target.isSprite()) {
            throw new Error('Cannot duplicate non-sprite targets.');
        } else if (!target.sprite) {
            throw new Error('No sprite associated with this target.');
        }
        return target.duplicate().then(newTarget => {
            this.runtime.addTarget(newTarget);
            newTarget.goBehindOther(target);
            this.setEditingTarget(newTarget.id);
        });
    }

    /**
     * Set the audio engine for the VM/runtime
     * @param {!AudioEngine} audioEngine The audio engine to attach
     */
    attachAudioEngine (audioEngine) {
        this.runtime.attachAudioEngine(audioEngine);
    }

    /**
     * Set the renderer for the VM/runtime
     * @param {!RenderWebGL} renderer The renderer to attach
     */
    attachRenderer (renderer) {
        this.runtime.attachRenderer(renderer);
    }

    /**
     * @returns {RenderWebGL} The renderer attached to the vm
     */
    get renderer () {
        return this.runtime && this.runtime.renderer;
    }

    // @deprecated
    attachV2SVGAdapter () {
    }

    /**
     * Set the bitmap adapter for the VM/runtime, which converts scratch 2
     * bitmaps to scratch 3 bitmaps. (Scratch 3 bitmaps are all bitmap resolution 2)
     * @param {!function} bitmapAdapter The adapter to attach
     */
    attachV2BitmapAdapter (bitmapAdapter) {
        this.runtime.attachV2BitmapAdapter(bitmapAdapter);
    }

    /**
     * Set the storage module for the VM/runtime
     * @param {!ScratchStorage} storage The storage module to attach
     */
    attachStorage (storage) {
        this.runtime.attachStorage(storage);
    }

    /**
     * set the current locale and builtin messages for the VM
     * @param {!string} locale       current locale
     * @param {!object} messages     builtin messages map for current locale
     * @returns {Promise} Promise that resolves when all the blocks have been
     *     updated for a new locale (or empty if locale hasn't changed.)
     */
    setLocale (locale, messages) {
        if (locale !== formatMessage.setup().locale) {
            formatMessage.setup({locale: locale, translations: {[locale]: messages}});
        }
        return this.extensionManager.refreshBlocks();
    }

    /**
     * get the current locale for the VM
     * @returns {string} the current locale in the VM
     */
    getLocale () {
        return formatMessage.setup().locale;
    }

    /**
     * Handle a Blockly event for the current editing target.
     * @param {!Blockly.Event} e Any Blockly event.
     */
    blockListener (e) {
        if (this.editingTarget) {
            this.editingTarget.blocks.blocklyListen(e);
        }
    }

    /**
     * Handle a Blockly event for the flyout.
     * @param {!Blockly.Event} e Any Blockly event.
     */
    flyoutBlockListener (e) {
        this.runtime.flyoutBlocks.blocklyListen(e);
    }

    /**
     * Handle a Blockly event for the flyout to be passed to the monitor container.
     * @param {!Blockly.Event} e Any Blockly event.
     */
    monitorBlockListener (e) {
        // Filter events by type, since monitor blocks only need to listen to these events.
        // Monitor blocks shouldn't be destroyed when flyout blocks are deleted.
        if (['create', 'change'].indexOf(e.type) !== -1) {
            this.runtime.monitorBlocks.blocklyListen(e);
        }
    }

    /**
     * Handle a Blockly event for the variable map.
     * @param {!Blockly.Event} e Any Blockly event.
     */
    variableListener (e) {
        // Filter events by type, since blocks only needs to listen to these
        // var events.
        if (['var_create', 'var_rename', 'var_delete'].indexOf(e.type) !== -1) {
            this.runtime.getTargetForStage().blocks.blocklyListen(e);
        }
    }

    /**
     * Set an editing target. An editor UI can use this function to switch
     * between editing different targets, sprites, etc.
     * After switching the editing target, the VM may emit updates
     * to the list of targets and any attached workspace blocks
     * (see `emitTargetsUpdate` and `emitWorkspaceUpdate`).
     * @param {string} targetId Id of target to set as editing.
     */
    setEditingTarget (targetId) {
        // Has the target id changed? If not, exit.
        if (this.editingTarget && targetId === this.editingTarget.id) {
            return;
        }
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            this.editingTarget = target;
            // Emit appropriate UI updates.
            this.emitTargetsUpdate(false /* Don't emit project change */);
            this.emitWorkspaceUpdate();
            this.runtime.setEditingTarget(target);
        }
    }

    /**
     * Called when blocks are dragged from one sprite to another. Adds the blocks to the
     * workspace of the given target.
     * @param {!Array<object>} blocks Blocks to add.
     * @param {!string} targetId Id of target to add blocks to.
     * @param {?string} optFromTargetId Optional target id indicating that blocks are being
     * shared from that target. This is needed for resolving any potential variable conflicts.
     * @return {!Promise} Promise that resolves when the extensions and blocks have been added.
     */
    shareBlocksToTarget (blocks, targetId, optFromTargetId) {
        const sb3 = require('./serialization/sb3');

        const copiedBlocks = JSON.parse(JSON.stringify(blocks));
        newBlockIds(copiedBlocks);
        const target = this.runtime.getTargetById(targetId);

        if (optFromTargetId) {
            // If the blocks are being shared from another target,
            // resolve any possible variable conflicts that may arise.
            const fromTarget = this.runtime.getTargetById(optFromTargetId);
            fromTarget.resolveVariableSharingConflictsWithTarget(copiedBlocks, target);
        }

        // Create a unique set of extensionIds that are not yet loaded
        const extensionIDs = new Set(copiedBlocks
            .map(b => sb3.getExtensionIdForOpcode(b.opcode))
            .filter(id => !!id) // Remove ids that do not exist
            .filter(id => !this.extensionManager.isExtensionLoaded(id)) // and remove loaded extensions
        );

        // Create an array promises for extensions to load
        const extensionPromises = Array.from(extensionIDs,
            id => this.extensionManager.loadExtensionURL(id)
        );

        return Promise.all(extensionPromises).then(() => {
            copiedBlocks.forEach(block => {
                target.blocks.createBlock(block);
            });
            target.blocks.updateTargetSpecificBlocks(target.isStage);
        });
    }

    /**
     * Called when costumes are dragged from editing target to another target.
     * Sets the newly added costume as the current costume.
     * @param {!number} costumeIndex Index of the costume of the editing target to share.
     * @param {!string} targetId Id of target to add the costume.
     * @return {Promise} Promise that resolves when the new costume has been loaded.
     */
    shareCostumeToTarget (costumeIndex, targetId) {
        const originalCostume = this.editingTarget.getCostumes()[costumeIndex];
        const clone = Object.assign({}, originalCostume);
        const md5ext = `${clone.assetId}.${clone.dataFormat}`;
        return loadCostume(md5ext, clone, this.runtime).then(() => {
            const target = this.runtime.getTargetById(targetId);
            if (target) {
                target.addCostume(clone);
                target.setCostume(
                    target.getCostumes().length - 1
                );
            }
        });
    }

    /**
     * Called when sounds are dragged from editing target to another target.
     * @param {!number} soundIndex Index of the sound of the editing target to share.
     * @param {!string} targetId Id of target to add the sound.
     * @return {Promise} Promise that resolves when the new sound has been loaded.
     */
    shareSoundToTarget (soundIndex, targetId) {
        const originalSound = this.editingTarget.getSounds()[soundIndex];
        const clone = Object.assign({}, originalSound);
        const target = this.runtime.getTargetById(targetId);
        return loadSound(clone, this.runtime, target.sprite.soundBank).then(() => {
            if (target) {
                target.addSound(clone);
                this.emitTargetsUpdate();
            }
        });
    }

    /**
     * Repopulate the workspace with the blocks of the current editingTarget. This
     * allows us to get around bugs like gui#413.
     */
    refreshWorkspace () {
        if (this.editingTarget) {
            this.emitWorkspaceUpdate();
            this.runtime.setEditingTarget(this.editingTarget);
            this.emitTargetsUpdate(false /* Don't emit project change */);
        }
    }

    /**
     * Emit metadata about available targets.
     * An editor UI could use this to display a list of targets and show
     * the currently editing one.
     * @param {bool} triggerProjectChange If true, also emit a project changed event.
     * Disabled selectively by updates that don't affect project serialization.
     * Defaults to true.
     */
    emitTargetsUpdate (triggerProjectChange) {
        if (typeof triggerProjectChange === 'undefined') triggerProjectChange = true;
        this.runtime.targets.map((v,i)=>{
            console.log('%c'+i+'id--'+v.id+'--组名'+v.sprite.customField.groupId+'--'+v.sprite.customField.spriteIndexInGroup+'--'+v.sprite.name,'color:green')
        })
        //
        this.emit('targetsUpdate', {
            // [[target id, human readable target name], ...].
            targetList: this.runtime.targets
                .filter(
                    // Don't report clones.
                    target => !target.hasOwnProperty('isOriginal') || target.isOriginal
                ).map(
                    target =>{
                        return target.toJSON()
                    } 
                ),
            // Currently editing target id.
            editingTarget: this.editingTarget ? this.editingTarget.id : null
        });
        if (triggerProjectChange) {
            this.runtime.emitProjectChanged();
        }
    }

    /**
     * Emit an Blockly/scratch-blocks compatible XML representation
     * of the current editing target's blocks.
     */
    emitWorkspaceUpdate () {
        // Create a list of broadcast message Ids according to the stage variables
        const stageVariables = this.runtime.getTargetForStage().variables;
        let messageIds = [];
        for (const varId in stageVariables) {
            if (stageVariables[varId].type === Variable.BROADCAST_MESSAGE_TYPE) {
                messageIds.push(varId);
            }
        }
        // Go through all blocks on all targets, removing referenced
        // broadcast ids from the list.
        for (let i = 0; i < this.runtime.targets.length; i++) {
            const currTarget = this.runtime.targets[i];
            const currBlocks = currTarget.blocks._blocks;
            for (const blockId in currBlocks) {
                if (currBlocks[blockId].fields.BROADCAST_OPTION) {
                    const id = currBlocks[blockId].fields.BROADCAST_OPTION.id;
                    const index = messageIds.indexOf(id);
                    if (index !== -1) {
                        messageIds = messageIds.slice(0, index)
                            .concat(messageIds.slice(index + 1));
                    }
                }
            }
        }
        // Anything left in messageIds is not referenced by a block, so delete it.
        for (let i = 0; i < messageIds.length; i++) {
            const id = messageIds[i];
            delete this.runtime.getTargetForStage().variables[id];
        }
        const globalVarMap = Object.assign({}, this.runtime.getTargetForStage().variables);
        const localVarMap = this.editingTarget.isStage ?
            Object.create(null) :
            Object.assign({}, this.editingTarget.variables);

        const globalVariables = Object.keys(globalVarMap).map(k => globalVarMap[k]);
        const localVariables = Object.keys(localVarMap).map(k => localVarMap[k]);
        const workspaceComments = Object.keys(this.editingTarget.comments)
            .map(k => this.editingTarget.comments[k])
            .filter(c => c.blockId === null);

        const xmlString = `<xml xmlns="http://www.w3.org/1999/xhtml">
                            <variables>
                                ${globalVariables.map(v => v.toXML()).join()}
                                ${localVariables.map(v => v.toXML(true)).join()}
                            </variables>
                            ${workspaceComments.map(c => c.toXML()).join()}
                            ${this.editingTarget.blocks.toXML(this.editingTarget.comments)}
                        </xml>`;

        this.emit('workspaceUpdate', {xml: xmlString});
    }

    /**
     * Get a target id for a drawable id. Useful for interacting with the renderer
     * @param {int} drawableId The drawable id to request the target id for
     * @returns {?string} The target id, if found. Will also be null if the target found is the stage.
     */
    getTargetIdForDrawableId (drawableId) {
        const target = this.runtime.getTargetByDrawableId(drawableId);
        if (target && target.hasOwnProperty('id') && target.hasOwnProperty('isStage') && !target.isStage) {
            return target.id;
        }
        return null;
    }

    /**
     * Reorder target by index. Return whether a change was made.
     * @param {!string} targetIndex Index of the target.
     * @param {!number} newIndex index that the target should be moved to.
     * @returns {boolean} Whether a target was reordered.
     */
    reorderTarget (targetIndex, newIndex) {
        let targets = this.runtime.targets;
        targetIndex = MathUtil.clamp(targetIndex, 0, targets.length - 1);
        newIndex = MathUtil.clamp(newIndex, 0, targets.length - 1);
        if (targetIndex === newIndex) return false;
        const target = targets[targetIndex];
        targets = targets.slice(0, targetIndex).concat(targets.slice(targetIndex + 1));
        targets.splice(newIndex, 0, target);
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
        //它的实现原理是交换renderTarget中的item的位置。
        //我们加入分组的原理，是需要拿到鼠标所在的index，然后修改被拖拽的sprite.customField信息,也就是groupName,groupIndex等。同时，外层sprite因为被移动，外层的index序列需要对应变化
        return true;
    }
    reorderTargetByObj(droppedObj,draggedObj){
        let targets = this.runtime.targets;
        let dropIndex,dragIndex;
        targets.map((item,index)=>{
            if(item.id===droppedObj.id){
                dropIndex= index
            }
            if(item.id===draggedObj.id){
                dragIndex= index
            }
        })
        this.reorderTarget(dragIndex,dropIndex)
        let temArr=targets[dropIndex]
        targets[dropIndex]=targets[dragIndex]
        targets[dragIndex]=temArr
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }  

    /**
     * Reorder the costumes of a target if it exists. Return whether it succeeded.
     * @param {!string} targetId ID of the target which owns the costumes.
     * @param {!number} costumeIndex index of the costume to move.
     * @param {!number} newIndex index that the costume should be moved to.
     * @returns {boolean} Whether a costume was reordered.
     */
    reorderCostume (targetId, costumeIndex, newIndex) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            const reorderSuccessful = target.reorderCostume(costumeIndex, newIndex);
            if (reorderSuccessful) {
                this.runtime.emitProjectChanged();
            }
            return reorderSuccessful;
        }
        return false;
    }

    /**
     * Reorder the sounds of a target if it exists. Return whether it occured.
     * @param {!string} targetId ID of the target which owns the sounds.
     * @param {!number} soundIndex index of the sound to move.
     * @param {!number} newIndex index that the sound should be moved to.
     * @returns {boolean} Whether a sound was reordered.
     */
    reorderSound (targetId, soundIndex, newIndex) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            const reorderSuccessful = target.reorderSound(soundIndex, newIndex);
            if (reorderSuccessful) {
                this.runtime.emitProjectChanged();
            }
            return reorderSuccessful;
        }
        return false;
    }

    /**
     * Put a target into a "drag" state, during which its X/Y positions will be unaffected
     * by blocks.
     * @param {string} targetId The id for the target to put into a drag state
     */
    startDrag (targetId) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            this._dragTarget = target;
            target.startDrag();
        }
    }

    /**
     * Remove a target from a drag state, so blocks may begin affecting X/Y position again
     * @param {string} targetId The id for the target to remove from the drag state
     */
    stopDrag (targetId) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            this._dragTarget = null;
            target.stopDrag();
            this.setEditingTarget(target.sprite && target.sprite.clones[0] ?
                target.sprite.clones[0].id : target.id);
        }
    }

    /**
     * Post/edit sprite info for the current editing target or the drag target.
     * @param {object} data An object with sprite info data to set.
     */
    postSpriteInfo (data) {
        if (this._dragTarget) {
            this._dragTarget.postSpriteInfo(data);
        } else {
            this.editingTarget.postSpriteInfo(data);
        }
        // Post sprite info means the gui has changed something about a sprite,
        // either through the sprite info pane fields (e.g. direction, size) or
        // through dragging a sprite on the stage
        // Emit a project changed event.
        this.runtime.emitProjectChanged();
    }

    /**
     * Set a target's variable's value. Return whether it succeeded.
     * @param {!string} targetId ID of the target which owns the variable.
     * @param {!string} variableId ID of the variable to set.
     * @param {!*} value The new value of that variable.
     * @returns {boolean} whether the target and variable were found and updated.
     */
    setVariableValue (targetId, variableId, value) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            const variable = target.lookupVariableById(variableId);
            if (variable) {
                variable.value = value;

                if (variable.isCloud) {
                    this.runtime.ioDevices.cloud.requestUpdateVariable(variable.name, variable.value);
                }

                return true;
            }
        }
        return false;
    }

    /**
     * Get a target's variable's value. Return null if the target or variable does not exist.
     * @param {!string} targetId ID of the target which owns the variable.
     * @param {!string} variableId ID of the variable to set.
     * @returns {?*} The value of the variable, or null if it could not be looked up.
     */
    getVariableValue (targetId, variableId) {
        const target = this.runtime.getTargetById(targetId);
        if (target) {
            const variable = target.lookupVariableById(variableId);
            if (variable) {
                return variable.value;
            }
        }
        return null;
    }

    /**
     * Allow VM consumer to configure the ScratchLink socket creator.
     * @param {Function} factory The custom ScratchLink socket factory.
     */
    configureScratchLinkSocketFactory (factory) {
        this.runtime.configureScratchLinkSocketFactory(factory);
    }
    isGroupIn(currentTargetOrSprite){ //接收参数可以为target也可以为sprite//true代表当前targets是组内sprite false为组外sprite
        if(currentTargetOrSprite.hasOwnProperty('sprite')){
             return Object.keys(currentTargetOrSprite.sprite.customField).length!=0
        }else{
             return Object.keys(currentTargetOrSprite.customField).length!=0
        }
         
     }
    isSameGroup(currentTarget,objCustomFieldGroupId){//true代表drop的sprite的组id跟当前sprite的组是为同一组 false则不是
         return currentTarget.sprite.customField.groupId===objCustomFieldGroupId
     }
    ifAafterB(currentTarget,tempDropSpriteIndexInGroup){//// true代表当前sprite的组内index大于drag的组内index
         return currentTarget.sprite.customField.spriteIndexInGroup>tempDropSpriteIndexInGroup
     }
    isANoBeforeBInGroup(currentTarget,tempTarget){
        return currentTarget.sprite.customField.spriteIndexInGroup>=tempTarget.sprite.customField.spriteIndexInGroup
    }   
    isCaptain(target){
         if(typeof target=='object'){
             return target.customField.spriteIndexInGroup===0
         }else{
             return target===0
         }
         
       }
    
    currentAisFatherToB(currentTarget,actionTarget){
         return currentTarget.id===actionTarget.id
      }  
    getFieldByTarget(currentTarget,attribute){//getField(v,'spriteIndexInGroup') getField(v,'groupId')
         return currentTarget.sprite.customField[attribute]
     }
    getFieldBySprite(currentSprite,attribute){
         return currentSprite.customField[attribute]
     }
    case1(droppedObj,draggedObj){//reorderTargetByObj
        let targets = this.runtime.targets;
        let dropIndex,dragIndex;
        targets.map((item,index)=>{
            if(item.id===droppedObj.id){
                dropIndex= index
            }
            if(item.id===draggedObj.id){
                dragIndex= index
            }
        })
        this.reorderTarget(dragIndex,dropIndex)
        let temArr=targets[dropIndex]
        targets[dropIndex]=targets[dragIndex]
        targets[dragIndex]=temArr
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    case2(droppedObj, draggedObj) {//reorderMixedTarget
      var that =this
      
      let targets = this.runtime.targets;
      let tempDrag
      let tempDropTarget
      let temDropGroupId=this.getFieldBySprite(droppedObj,'groupId')
      let pro = new Promise(function(resolve){
      targets.map((v,i)=>{
              if(v.id==draggedObj.id){
                  tempDrag=v
                  targets.splice(i,1)
                 
              }
              if(v.id==droppedObj.id){  
                tempDropTarget=v
                temDropGroupId=v.sprite.customField.groupId
                }
                resolve()
          })
      })
      //此处有Bug,没有对插入组员做处理
      pro.then(function(){
        return new Promise(function(resolve){  
            try{
                tempDrag.sprite.customField= Object.assign({}, tempDropTarget.sprite.customField)
                tempDrag.sprite.customField.spriteIndexInGroup++
            }catch(e){console.log(e)}
                targets.map((v)=>{
                //其他所有因为插入的sprite的spriteIndexInGroup需要对应+1
                if(that.isGroupIn(v)&&that.isSameGroup(v,temDropGroupId)&&that.ifAafterB(v,that.getFieldByTarget(tempDropTarget,'spriteIndexInGroup'))){
                    v.sprite.customField.spriteIndexInGroup++
                }
            })
         
           resolve()
            })
      }).then(function(){
          targets.map((value,index)=>{
              if(value.id==tempDropTarget.id){
                  targets.splice(index+1,0,tempDrag)
                  //需要修改按顺序对应重排targets
                  that.runtime.targets = targets;
                  that.emitTargetsUpdate();
              }
          })
           //droppobj targets index
      })
    
  }
  case3(targetId, draggedObj){
    let targets = this.runtime.targets;
    let that =this
    let tempDrag
    let tempDropTarget
    let temDropGroupId=targetId
    let temDragGroupId=draggedObj.customField.groupId
    let tempSpriteIndexInGroup=draggedObj.customField.spriteIndexInGroup
    var pro =new Promise(function(resolve){
        targets.map((v,i)=>{
            console.log('1')
            //1先存drag sprite tempDrag
            if(v.id==draggedObj.id){
                tempDrag=v
                targets.splice(i,1)
                resolve()
                return 
            }
          
        })
    })
     pro.then(function(){
         return new Promise(function(resolve){
            targets.map((v,i)=>{
            //2 如果dragsprite还有其他得sprite，修改在其之后的sprite的组内Index
            if(Object.keys(v.sprite.customField).length!=0&&v.sprite.customField.groupId===temDragGroupId&&v.sprite.customField.spriteIndexInGroup>tempSpriteIndexInGroup){
                if(tempSpriteIndexInGroup===0&&v.sprite.customField.spriteIndexInGroup===1){ 
            //3如果dragsprite是队长，还需要移交队长，修改其他所有sprite的groupId为新队长
                  v.sprite.customField.groupId=v.id+'g'
                }
                v.sprite.customField.spriteIndexInGroup=v.sprite.customField.spriteIndexInGroup-1
            }
         
            //4取得drop信息
            if(v.sprite.customField.groupId==targetId&&v.sprite.customField.spriteIndexInGroup==0){
                tempDropTarget=v
                temDropGroupId=v.sprite.customField.groupId
            }
            })
         
            resolve()
         })
     }).then(function(){
        // //5按drop信息修改drag组名，index+1,并且所有在其之后的组员的spriteIndexInGroup对应+1
       return new Promise(function(resolve){
        try{
            tempDrag.sprite.customField= Object.assign({}, tempDropTarget.sprite.customField)
            tempDrag.sprite.customField.spriteIndexInGroup=0
        }catch(e){console.log(e)}
            targets.map((v,i)=>{
            //其他所有因为插入的sprite的spriteIndexInGroup需要对应+1
            if(Object.keys(v.sprite.customField).length!=0&&v.sprite.customField.groupId===temDropGroupId&&v.sprite.customField.spriteIndexInGroup>=tempDropTarget.sprite.customField.spriteIndexInGroup){
                v.sprite.customField.spriteIndexInGroup=v.sprite.customField.spriteIndexInGroup+1
            }
        })
        resolve()
       })
     }).then(function(){
        targets.map((v,i)=>{
            if(v.id===tempDropTarget.id){
                targets.splice(i+1,0,tempDrag)
            }
        })
        console.log('有Bug,这里的targets生成额组内顺序不对',targets)
        that.runtime.targets = targets;
        that.emitTargetsUpdate();
     })
   

    //这里的情况是不同组sprite拉动，drag sprite要加入dropsprite的对应位置。
}
    case4(draggedObj){
        const targets = this.runtime.targets
        let temArr=null
        targets.map((v,i)=>{
            if(draggedObj.id===v.id){
                temArr=v
                targets.splice(i,1)
            }
        })
        targets.splice(1,0,temArr)
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    case5(draggedObj){
        const targets = this.runtime.targets
        let temArr=null
        targets.map((v,i)=>{
            if(draggedObj.id===v.id){
                temArr=v
                targets.splice(i,1)
            }
        })
        targets.push(temArr)
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
    case6 (droppedObj, draggedObj) {//17种case适用于case6 reorderSpriteInGroup
        let targets = this.runtime.targets;
         //如果droppedObj, draggedObj中有任意一个sprite被跟组长sprite交换，要修改对应所有组员的groupId为draggedObj的spriteId+'g'。
        let captainSpriteId=draggedObj.customField.groupId.substring(0, droppedObj.customField.groupId.lastIndexOf('g'))
        let newCaptainSpriteId;
        if(droppedObj.id==captainSpriteId){//如果drop的是队长，draggedObj.id就是新的队长id
            newCaptainSpriteId=draggedObj.id+'g'
        }else if(draggedObj.id==captainSpriteId){//如果drag的是队长，droppedObj.id就是新的队长id
            newCaptainSpriteId=droppedObj.id+'g'
         }
        var dropSpriteIndex=this.getFieldBySprite(droppedObj,'spriteIndexInGroup')
        var dragSpriteIndex=this.getFieldBySprite(draggedObj,'spriteIndexInGroup')
        let dropIndex,dragIndex;
        targets.map((v,index)=>{
            if(newCaptainSpriteId&&this.getFieldByTarget(v,'groupId')==captainSpriteId+'g'){//如果，drop或drag其中有队长，则产生新的队长id
                v.sprite.customField.groupId=newCaptainSpriteId
            }
            if(v.id==droppedObj.id){
                v.sprite.customField.spriteIndexInGroup=dragSpriteIndex
                dropIndex= index
            }
            if(v.id==draggedObj.id){
                v.sprite.customField.spriteIndexInGroup=dropSpriteIndex
                dragIndex= index
            }
        })
        let temArr=targets[dropIndex]
        targets[dropIndex]=targets[dragIndex]
        targets[dragIndex]=temArr
        //这里不仅需要修改spriteIndexInGroup,还需要修改按顺序对应重排targets
        this.runtime.targets = targets;
        this.emitTargetsUpdate();
    }
   
     case7(droppedObj, draggedObj){
         let targets = this.runtime.targets;
         let that =this
         let tempDrag
         let tempDropTarget
         let temDropGroupId=this.getFieldBySprite(droppedObj,'groupId')
         let temDragGroupId=this.getFieldBySprite(draggedObj,'groupId')
         let tempSpriteIndexInGroup=this.getFieldBySprite(draggedObj,'spriteIndexInGroup')
         let newCaptainSpriteId=null
         var pro =new Promise(function(resolve){
             targets.map((v,i)=>{
                 //1先存drag sprite tempDrag
                 if(that.currentAisFatherToB(v,draggedObj)){
                     tempDrag=v
                     targets.splice(i,1)
                     resolve()
                     return 
                 }
               
             })
         })
          pro.then(function(){
              return new Promise(function(resolve){
                 targets.map((v)=>{
                     //2 如果dragsprite还有其他得sprite，修改在其之后的sprite的组内Index
                 if(that.isGroupIn(v)&&that.isSameGroup(v,temDragGroupId)&&that.ifAafterB(v,tempSpriteIndexInGroup)){
                     if(that.isCaptain(tempSpriteIndexInGroup)&&that.getFieldByTarget(v,'spriteIndexInGroup')===1){ 
                       //3如果dragsprite是队长，还需要移交队长，修改其他所有sprite的groupId为新队长
                       console.log('记录队长信息应该只触发一次,temDragGroupId',temDragGroupId)
                       console.log('current Target name',v.sprite.name)
                       console.log('cuurent Target id',v.id)
                       v.sprite.customField.groupId=v.id+'g'
                      
                       newCaptainSpriteId=v.id+'g'
                     }
                     if(newCaptainSpriteId){
                         console.log('队员写新队长信息',newCaptainSpriteId)
                        v.sprite.customField.groupId=newCaptainSpriteId
                       }
                     v.sprite.customField.spriteIndexInGroup--
                 }
                 // //4取得drop信息
                 if(v.id==droppedObj.id){
                     tempDropTarget=v
                     temDropGroupId=v.sprite.customField.groupId
                 }
                 })
                 resolve()
              })
          }).then(function(){
             // //5按drop信息修改drag组名，index+1,并且所有在其之后的组员的spriteIndexInGroup对应+1
            return new Promise(function(resolve){
             try{
                 tempDrag.sprite.customField= Object.assign({}, tempDropTarget.sprite.customField)
                 tempDrag.sprite.customField.spriteIndexInGroup++
             }catch(e){console.log(e)}
                 targets.map((v)=>{
                 //其他所有因为插入的sprite的spriteIndexInGroup需要对应+1
                 if(that.isGroupIn(v)&&that.isSameGroup(v,temDropGroupId)&&that.ifAafterB(v,that.getFieldByTarget(tempDropTarget,'spriteIndexInGroup'))){
                     v.sprite.customField.spriteIndexInGroup++
                 }
             })
             resolve()
            })
            
          }).then(function(){
             targets.map((v,i)=>{
                 if(v.id===tempDropTarget.id){
                     targets.splice(i+1,0,tempDrag)
                 }
             })
             that.runtime.targets = targets;
             that.emitTargetsUpdate();
          })
        
 
         //这里的情况是不同组sprite拉动，drag sprite要加入dropsprite的对应位置。
     }
    case8 (draggedObj) {//17种case适用于case6 reorderSpriteInGroup
        let targets = this.runtime.targets;
        let that=this
        let oldGroupId=draggedObj.customField.groupId
        let captainSpriteId=draggedObj.customField.groupId.substring(0, draggedObj.customField.groupId.lastIndexOf('g'))
        let tempDrag
        let oldCaptainIndex
            //不是队长，先存tempDrag,找到旧队长，记录队长index,将drag的id设为队长id，之前的所有队员全部修改成新id，
            //删除drag,在旧队长前面插入temp
            var pro = new Promise(function(resolve,){
                targets.map((v,i)=>{
                    if(v.id===draggedObj.id){
                        tempDrag=v
                    }
                    if(v.id===captainSpriteId){
                        oldCaptainIndex=i
                    }
                    if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===oldGroupId){
                        v.sprite.customField.groupId=draggedObj.id+'g'
                        v.sprite.customField.spriteIndexInGroup=v.sprite.customField.spriteIndexInGroup+1
                    }  
                })
                resolve()
            })
            pro.then(function(){
                targets.map((v,i)=>{
                    if(v.id===draggedObj.id){
                        tempDrag=v
                        targets.splice(i,1)
                    }
                })
                tempDrag.sprite.customField.spriteIndexInGroup=0  
                targets.splice(oldCaptainIndex,0,tempDrag)
                that.runtime.targets = targets;
                that.emitTargetsUpdate();  
            })
    }
    case9(targetId, draggedObj){
        let targets = this.runtime.targets;
        let that =this
        let tempDrag
        let tempDropTarget
        let temDropGroupId=targetId
        let temDragGroupId=draggedObj.customField.groupId
        let tempSpriteIndexInGroup=draggedObj.customField.spriteIndexInGroup
        var pro =new Promise(function(resolve){
            targets.map((v,i)=>{
                console.log('1')
                //1先存drag sprite tempDrag
                if(v.id==draggedObj.id){
                    tempDrag=v
                    targets.splice(i,1)
                    resolve()
                    return 
                }
              
            })
        })
         pro.then(function(){
             return new Promise(function(resolve){
                targets.map((v,i)=>{
                //2 如果dragsprite还有其他得sprite，修改在其之后的sprite的组内Index
                if(Object.keys(v.sprite.customField).length!=0&&v.sprite.customField.groupId===temDragGroupId&&v.sprite.customField.spriteIndexInGroup>tempSpriteIndexInGroup){
                    if(tempSpriteIndexInGroup===0&&v.sprite.customField.spriteIndexInGroup===1){ 
                //3如果dragsprite是队长，还需要移交队长，修改其他所有sprite的groupId为新队长
                      v.sprite.customField.groupId=v.id+'g'
                    }
                    v.sprite.customField.spriteIndexInGroup=v.sprite.customField.spriteIndexInGroup-1
                }
             
                //4取得drop信息
                if(v.sprite.customField.groupId==targetId&&v.sprite.customField.spriteIndexInGroup==0){
                    tempDropTarget=v
                    temDropGroupId=v.sprite.customField.groupId
                }
                })
             
                resolve()
             })
         }).then(function(){
            // //5按drop信息修改drag组名，index+1,并且所有在其之后的组员的spriteIndexInGroup对应+1
           return new Promise(function(resolve){
            try{
                tempDrag.sprite.customField= Object.assign({}, tempDropTarget.sprite.customField)
                tempDrag.sprite.customField.spriteIndexInGroup=0
            }catch(e){console.log(e)}
                targets.map((v,i)=>{
                //其他所有因为插入的sprite的spriteIndexInGroup需要对应+1
                if(Object.keys(v.sprite.customField).length!=0&&v.sprite.customField.groupId===temDropGroupId&&v.sprite.customField.spriteIndexInGroup>=tempDropTarget.sprite.customField.spriteIndexInGroup){
                    v.sprite.customField.spriteIndexInGroup=v.sprite.customField.spriteIndexInGroup+1
                }
            })
            resolve()
           })
         }).then(function(){
            targets.map((v,i)=>{
                if(v.id===tempDropTarget.id){
                    targets.splice(i+1,0,tempDrag)
                }
            })
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
         })
       

        //这里的情况是不同组sprite拉动，drag sprite要加入dropsprite的对应位置。
    }
    case10(droppedObj, draggedObj){
        let targets = this.runtime.targets; 
        let that = this
        let oldCaptainSpriteId = draggedObj.customField.groupId
        let isGetNewCap=false
        let newCaptainSpriteId
        let dragTarget
        let pro = new Promise(function(resolve){
            targets.map((v,i)=>{
                if(v.id===draggedObj.id){
                    dragTarget=v
                    dragTarget.sprite.customField={}
                    targets.splice(i,1)
                    resolve()
                }
            }) 
        })
        pro.then(function(){
            return new Promise(function (resolve) {
                targets.map((v,i)=>{
                    if(v.id===droppedObj.id){
                        targets.splice(i+1,0,dragTarget)
                        resolve()
                    }
                }) 
            });
        }).then(function(){
            targets.map((v,i)=>{
                if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===oldCaptainSpriteId){
                    if(!isGetNewCap){
                        newCaptainSpriteId=v.id+'g'
                        isGetNewCap=true
                    }
                    v.sprite.customField.groupId=newCaptainSpriteId
                }
            })
            that.runtime.targets = targets;
            that.emitTargetsUpdate();  
        })
    }
    case11(draggedObj){//类似case5但是需要清除分组信息
        const targets = this.runtime.targets
        let temArr=null
        let that = this
        let newCaptainSpriteId
        let temDragGroupId=this.getFieldBySprite(draggedObj,'groupId')
        let tempSpriteIndexInGroup=this.getFieldBySprite(draggedObj,'spriteIndexInGroup')
        var pro=new Promise(function(resolve,reject){
            targets.map((v,i)=>{
                if(draggedObj.id===v.id){
                    temArr=v
                    temArr.sprite.customField={}
                    targets.splice(i,1)
                }
            })
            resolve()
        })
        //原来的分组信息需要对应修改
        pro.then(function(){
            return new Promise(function(resolve){  
               targets.map((v)=>{
                   //2 如果dragsprite还有其他得sprite，修改在其之后的sprite的组内Index
               if(that.isGroupIn(v)&&that.isSameGroup(v,temDragGroupId)&&that.ifAafterB(v,tempSpriteIndexInGroup)){
                   if(that.isCaptain(tempSpriteIndexInGroup)&&that.getFieldByTarget(v,'spriteIndexInGroup')==1){ 
                      
                     //3如果dragsprite是队长，还需要移交队长，修改其他所有sprite的groupId为新队长
                     v.sprite.customField.groupId=v.id+'g'
                     newCaptainSpriteId=v.id+'g'
                   }
                   if(newCaptainSpriteId){
                    v.sprite.customField.groupId=newCaptainSpriteId
                   }
                   
                   v.sprite.customField.spriteIndexInGroup--
               }
            
               })
               resolve()
            })
        }).then(function(){
            targets.splice(1,0,temArr)
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
    }
    case12(draggedObj){//类似case5但是需要清除分组信息
        const targets = this.runtime.targets
        let temArr=null
        let that = this
        let newCaptainSpriteId=null
        let temDragGroupId=this.getFieldBySprite(draggedObj,'groupId')
        let tempSpriteIndexInGroup=this.getFieldBySprite(draggedObj,'spriteIndexInGroup')
        var pro=new Promise(function(resolve,reject){
            targets.map((v,i)=>{
                if(draggedObj.id===v.id){
                    temArr=v
                    temArr.sprite.customField={}
                    targets.splice(i,1)
                }
            })
            resolve()
        })
        //原来的分组信息需要对应修改
        pro.then(function(){
            return new Promise(function(resolve){  
              
               targets.map((v)=>{
                   //2 如果dragsprite还有其他得sprite，修改在其之后的sprite的组内Index
               if(that.isGroupIn(v)&&that.isSameGroup(v,temDragGroupId)&&that.ifAafterB(v,tempSpriteIndexInGroup)){
                   if(that.isCaptain(tempSpriteIndexInGroup)&&that.getFieldByTarget(v,'spriteIndexInGroup')==1){ 
                    console.log('记录队长信息应该只触发一次,temDragGroupId',temDragGroupId)
                    console.log('current Target name',v.sprite.name)
                    console.log('cuurent Target id',v.id)
                     //3如果dragsprite是队长，还需要移交队长，修改其他所有sprite的groupId为新队长
                     v.sprite.customField.groupId=v.id+'g'
                     newCaptainSpriteId=v.id+'g'
                   }
                   if(newCaptainSpriteId){
                    console.log('队员写新队长信息',newCaptainSpriteId)
                    v.sprite.customField.groupId=newCaptainSpriteId
                   }
                   
                   v.sprite.customField.spriteIndexInGroup--
               }
            
               })
               resolve()
            })
        }).then(function(){
            targets.push(temArr)
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
    }
    case13(droppedObj,draggedObj){//case13 draggedObj是组 drop是sprite
        try{
            console.log('case13')
        let that =this
        let targets=copyTargets = this.runtime.targets;
        let dropIndexs=[]//被drop的组的所有sprice的target的所在index
        let dragIndexs=[]//抓起的组的所有sprice的target的所在index
        let dropTargets=[]//被drop的组的所有sprice的target
        let dragTargets=[]//抓起的对象的所有sprice的target
        let dragGroupId=Object.keys(draggedObj.customField).length!=0?draggedObj.customField.groupId:null//draggedObj如果没有分组的话dragGroupId就是Null
        let num 
        let shorterTailIndex
        let swopTimes//一共要交换的次数
        let whoIsLonger
        let insertIndexPlaceholder
        let pro = new Promise(function(resolve){
            targets.map((v,i)=>{
                if(v.id==droppedObj.id){
                    dropIndexs.push(i)
                    dropTargets.push(v)
                }
                if(that.isGroupIn(v)&&dragGroupId&&that.isSameGroup(v,dragGroupId)){//draggedObj.customField.groupId有可能不是组
                    dragIndexs.push(i)
                    dragTargets.push(v)
                }
                if(v.id==draggedObj.id&&dragGroupId==null){
                    dragIndexs.push(i)
                    dragTargets.push(v)
                }
            })
            if(dragTargets.length>0&&
                dropTargets.length>0&&
                dragIndexs.length>0&&
                dropIndexs.length>0){
                    console.log('dragTargets完成')
                    console.log(dragTargets)
                    console.log(dropTargets)
                    console.log(dragIndexs)
                    console.log(dropIndexs)
                    resolve()
                }
            
        })
        pro.then(function(){
            return new Promise(function(resolve){
                swopTimes= dropTargets.length
                console.log('swopTimes',swopTimes)
            if(dropTargets.length>dragTargets.length){
                 num =dropTargets.length - dragTargets.length
                 shorterTailIndex= dragIndexs[dragTargets.length-1]
                 swopTimes =dropTargets.length
                 whoIsLonger='dropIsLonger'
                
            }else if(dragTargets.length>dropTargets.length){
                 num =dragTargets.length - dropTargets.length
                 shorterTailIndex= dropIndexs[dropTargets.length-1]
                 swopTimes =dragTargets.length
                 whoIsLonger='dragIsLonger'
            }
            for(var i=0;i<num;i++){
                if(whoIsLonger==='dropIsLonger'){
                    dragIndexs.push(shorterTailIndex+i+1)
                    insertIndexPlaceholder=shorterTailIndex+i+1
                }else if(whoIsLonger==='dragIsLonger'){
                    dropIndexs.push(shorterTailIndex+i+1)
                    insertIndexPlaceholder=shorterTailIndex+i+1
                }
               
                targets.splice(shorterTailIndex+1,0,'placeHolder')
             
            }
            console.log('finishplaceholder',targets)
            resolve()
            })
        }).then(function(){
            return new Promise(function(resolve,reject){
                console.log('插完Placeholder的targets',targets)
                console.log('改造前的dropIndexs,dragIndexs',JSON.stringify(dropIndexs),JSON.stringify(dragIndexs))
                //这里再来算一遍临时的Index
                // var dropIndex=
                // targets.map
                if(dropIndexs[0]>=insertIndexPlaceholder){ //用于解决组分离bug，原因是插入placeHolder引起dropIndex变化导致查找的组sprite不准确
                    dropIndexs.map((v,i)=>{
                        dropIndexs[i]=v+num//如果drop 的组是drap后面，dropIndexs组的成员++
                        console.log('dropIndexs防止Bug修改为',v,num)
                    })
                    
                   
                }else if(dragIndexs[0]>=insertIndexPlaceholder){
                    dragIndexs.map((v,i)=>{
                        dragIndexs[i]=v+num//如果drop 的组是drap后面，dropIndexs组的成员++
                        console.log('dragIndexs防止Bug修改为',dropIndexs)
                    })
                  
                }
              
               resolve()
            })
           
        }).then(function(){
            console.log('改造后的dropIndexs,dragIndexs',JSON.stringify(dropIndexs),JSON.stringify(dragIndexs))
            console.log('改造后的dropTargets,dragTargets',dropTargets,dragTargets)
            for(var j=0;j<swopTimes;j++){
                let temArr=targets[dropIndexs[j]]
                targets[dropIndexs[j]]=targets[dragIndexs[j]]
                targets[dragIndexs[j]]=temArr
    
            }
            //最后删除所有'placeHolder'项
            function checkTargets(target) {
                return target!='placeHolder';
            }
            
            targets=targets.filter(checkTargets)
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
        }catch(e){console.log(e)}
        
    }
    case15(dropGroupId,draggedObj){//case15
        //原则上尽量一个case一个函数(单一职责)，不然容易产生回归Bug.
        //draggedObj是一个组得sprite，需要在targetsList中将dropsprite和drag的组的第一个sprite对调位置
        try{
            let that =this
        let targets=copyTargets = this.runtime.targets;
        let dropIndexs=[]//被drop的组的所有sprice的target的所在index
        let dragIndexs=[]//抓起的组的所有sprice的target的所在index
        let dropTargets=[]//被drop的组的所有sprice的target
        let dragTargets=[]//抓起的对象的所有sprice的target
        let dragGroupId=Object.keys(draggedObj.customField).length!=0?draggedObj.customField.groupId:null//draggedObj如果没有分组的话dragGroupId就是Null
        let num 
        let shorterTailIndex
        let swopTimes//一共要交换的次数
        let whoIsLonger
        let insertIndexPlaceholder
        let pro = new Promise(function(resolve){
            targets.map((v,i)=>{
                if(that.isGroupIn(v)&&that.isSameGroup(v,dropGroupId)){
                    dropIndexs.push(i)
                    dropTargets.push(v)
    
                }
                if(that.isGroupIn(v)&&dragGroupId&&that.isSameGroup(v,dragGroupId)){//draggedObj.customField.groupId有可能不是组
                    dragIndexs.push(i)
                    dragTargets.push(v)
                }
                if(v.id==draggedObj.id&&dragGroupId==null){
                    dragIndexs.push(i)
                    dragTargets.push(v)
                }
            })
            if(dragTargets.length>0&&
                dropTargets.length>0&&
                dragIndexs.length>0&&
                dropIndexs.length>0){
                    resolve()
                }
            
        })
        pro.then(function(){
            return new Promise(function(resolve,reject){
                swopTimes= dropTargets.length
            if(dropTargets.length>dragTargets.length){
                 num =dropTargets.length - dragTargets.length
                 shorterTailIndex= dragIndexs[dragTargets.length-1]
                 swopTimes =dropTargets.length
                 whoIsLonger='dropIsLonger'
                
            }else if(dragTargets.length>dropTargets.length){
                 num =dragTargets.length - dropTargets.length
                 shorterTailIndex= dropIndexs[dropTargets.length-1]
                 swopTimes =dragTargets.length
                 whoIsLonger='dragIsLonger'
            }
            for(var i=0;i<num;i++){
                if(whoIsLonger==='dropIsLonger'){
                    dragIndexs.push(shorterTailIndex+i+1)
                    insertIndexPlaceholder=shorterTailIndex+i+1
                }else if(whoIsLonger==='dragIsLonger'){
                    dropIndexs.push(shorterTailIndex+i+1)
                    insertIndexPlaceholder=shorterTailIndex+i+1
                }
               
                targets.splice(shorterTailIndex+1,0,'placeHolder')
              
            }
            resolve()
            })
        }).then(function(){
            return new Promise(function(resolve,reject){
                console.log('改造前的dropIndexs,dragIndexs',JSON.stringify(dropIndexs),JSON.stringify(dragIndexs))
                if(dropIndexs[0]>=insertIndexPlaceholder){ //用于解决组分离bug，原因是插入placeHolder引起dropIndex变化导致查找的组sprite不准确
                    dropIndexs.map((v,i)=>{
                        dropIndexs[i]=v+num//如果drop 的组是drap后面，dropIndexs组的成员++
                    })
                    
                   
                }else if(dragIndexs[0]>=insertIndexPlaceholder){
                    dragIndexs.map((v,i)=>{
                        dragIndexs[i]=v+num//如果drop 的组是drap后面，dropIndexs组的成员++
                    })
                }
                resolve()
            })
           
        }).then(function(){
            for(var j=0;j<swopTimes;j++){
                let temArr=targets[dropIndexs[j]]
                targets[dropIndexs[j]]=targets[dragIndexs[j]]
                targets[dragIndexs[j]]=temArr
    
            }
            //最后删除所有'placeHolder'项
            function checkTargets(target) {
                return target!='placeHolder';
            }
            
            targets=targets.filter(checkTargets)
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
        }catch(e){console.log(e)}
        
    }
    case16(draggedObj){//将drag组变成列表第一个
        //找出所有drag组成员保存，然后全部删除，最后在开头插入splice
        const targets = this.runtime.targets
        const groupId = draggedObj.customField.groupId
        const groupMembers=[]
        let that =this
        let pro = new Promise(function(resolve,reject){
            targets.map((v,i)=>{
                if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===groupId){
                    groupMembers.push(v)
                    targets.splice(i,1)
                    
                }
            })
            resolve()
        })
        pro.then(function(){
            for(var i=groupMembers.length-1;i>=0;i--){
                targets.splice(1,0,groupMembers[i])
            }
          
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
    }
    case17(draggedObj){//将drag组变成列表最后一个
        //找出所有drag组成员保存，然后全部删除，最后在开头插入splice
        let targets = this.runtime.targets

       
        let groupId = draggedObj.customField.groupId
        let groupMembers=[]
        let delIndex=[]
        let that =this   
        let pro = new Promise(function(resolve,reject){
            targets.map((v,i)=>{
                if(Object.keys(v.sprite.customField).length!==0&&v.sprite.customField.groupId===groupId){
                    groupMembers.push(v)
                    delIndex.push(i)
                }
            })
            resolve()
        })
        pro.then(function(){
            return new Promise(function(resolve){
               targets = targets.filter(v => v.sprite.customField.groupId!==groupId)
               resolve()
           })
        }).then(function(){
           targets.splice(targets.length,0,...groupMembers)
            that.runtime.targets = targets;
            that.emitTargetsUpdate();
        })
   }//将drag组变成列表最后一个
    checkTargets(target) {
        return target!='placeHolder';
    }

}

module.exports = VirtualMachine;
