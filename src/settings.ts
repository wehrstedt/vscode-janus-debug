import * as nodeDoc from 'node-documents-scripting';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as helpers from './helpers';

export const FORCE_UPLOAD_YES = 'Yes';
export const FORCE_UPLOAD_NO = 'No';
export const FORCE_UPLOAD_ALL = 'All';
export const FORCE_UPLOAD_NONE = 'None';
export const NO_CONFLICT = 'No conflict';

// tslint:disable-next-line:no-var-requires
const fs = require('fs-extra');
// tslint:disable-next-line:no-var-requires
const reduce = require('reduce-for-promises');

const invalidCharacters = /[\\\/:\*\?"<>\|]/;


// todo:
// spend a class here with vscode.workspace.getConfiguration('vscode-janus-debug', ...) in constructor


/**
 * @param serverInfo to be removed
 */
export function categoriesToFolders(conf: vscode.WorkspaceConfiguration, serverInfo: nodeDoc.ConnectionInformation, scripts: nodeDoc.scriptT[], targetDir: string) {

    // get category flag
    const categories = conf.get('categories', false);
    if (!categories) {
        return false;
    }

    // move this check to node-documents-scripting!
    if (Number(serverInfo.documentsVersion) < Number(nodeDoc.VERSION_CATEGORIES)) {
        vscode.window.showWarningMessage(`Using categories only available with server version ${nodeDoc.VERSION_CATEGORIES} or higher`);
        return;
    }

    let invalidName;
    const category = helpers.getCategoryFromPath(targetDir);
    if (category) {
        // the target folder is a category-folder
        // only save scripts from this category

        scripts.forEach((script: nodeDoc.scriptT) => {
            if (script.category === category) {
                script.path = path.join(targetDir, script.name + '.js');
            } else {
                script.path = "";
            }
        });
    } else {
        // the target folder is not a category-folder
        // create folders from categories

        scripts.forEach((script: nodeDoc.scriptT) => {
            if (script.category) {
                if (invalidCharacters.test(script.category)) {
                    path.parse(script.category);
                    script.path = "";
                    invalidName = script.category;
                } else {
                    script.path = path.join(targetDir, script.category + helpers.CATEGORY_FOLDER_POSTFIX, script.name + '.js');
                }
            }
        });
    }

    if (invalidName) {
        vscode.window.showWarningMessage(`Cannot create folder from category '${invalidName}' - please remove special characters`);
    }
}


/**
 * @param serverInfo to be removed
 */
export function foldersToCategories(conf: vscode.WorkspaceConfiguration, serverInfo: nodeDoc.ConnectionInformation, scripts: nodeDoc.scriptT[]) {

    // get category flag
    const categories = conf.get('categories', false);
    if (!categories) {
        return false;
    }

    // remove this check! this is already checked in node-documents-scripting!
    if (Number(serverInfo.documentsVersion) < Number(nodeDoc.VERSION_CATEGORIES)) {
        vscode.window.showWarningMessage(`Using categories only available with server version ${nodeDoc.VERSION_CATEGORIES} or higher`);
        return;
    }

    scripts.forEach((script: nodeDoc.scriptT) => {
        if (script.path) {
            script.category = helpers.getCategoryFromPath(script.path);
        }
    });
}





/**
 * Two things for script are checked:
 *
 * 1) has the category changed?
 * because the category is created from the folder
 * just make sure, that the category is not changed by mistake
 *
 * 2) has the source code on server changed?
 * this is only important if more than one people work on
 * the same server
 *
 * @param script user is asked, if this script should be uploaded
 * @param all true, if user selected 'all scripts should be uploaded'
 * @param none true, if user selected 'no script should be uploaded'
 * @param singlescript true, if user is asked for only one script
 * @param categories true, if the category setting is set
 */
async function askForUpload(script: nodeDoc.scriptT, all: boolean, none: boolean, singlescript: boolean, categories: boolean): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {

        // if lastSyncHash is not set, then confict has been set to true
        // so actually the case !conflict && !lastSyncHash is not possible here
        if (!script.conflict && script.lastSyncHash) {
            return resolve(NO_CONFLICT);
        }

        let answers = [FORCE_UPLOAD_YES, FORCE_UPLOAD_NO];
        let question;
        let answer;

        if (all) {
            return resolve(FORCE_UPLOAD_ALL);
        }
        if (none) {
            return resolve(FORCE_UPLOAD_NONE);
        }

        // first check category
        if (script.conflict && (script.conflict & nodeDoc.CONFLICT_CATEGORY)) {
            // only show warning, if category feature is used,
            // if it's not used, categories will never be changed on server
            // and the warning should be omitted in this case
            if (categories) {
                question = `Category of ${script.name} is different on server, upload anyway?`;
                answer = await vscode.window.showQuickPick(answers, { placeHolder: question });
            } else {
                answer = FORCE_UPLOAD_YES;
            }
        }

        // if script should not be force uploaded
        // we do not have to check the source code
        if (answer === FORCE_UPLOAD_NO) {
            return resolve(FORCE_UPLOAD_NO);
        }

        // now check source code
        if (script.conflict && (script.conflict & nodeDoc.CONFLICT_SOURCE_CODE)) {
            if (script.encrypted === 'true') {
                question = `${script.name} cannot be decrypted, source code might have been changed on server, upload anyway?`;
            } else if (script.lastSyncHash) {
                question = `Source code of ${script.name} has been changed on server, upload anyway?`;
            } else {
                // lastSyncHash not set, so we have no information if the source code on server has been changed
                question = `Source code of ${script.name} might have been changed on server, upload anyway?`;
            }
            if (!singlescript) {
                answers = [FORCE_UPLOAD_YES, FORCE_UPLOAD_NO, FORCE_UPLOAD_ALL, FORCE_UPLOAD_NONE];
            }
            answer = await vscode.window.showQuickPick(answers, { placeHolder: question });
        }

        return resolve(answer);
    });
}

/**
 * Ask user for all conflicted scripts if they should be force uploaded or if upload should
 * be cancelled
 *
 * @param param List of potentially conflicted scripts.
 *
 * @return Two arrays containing scripts of input array.
 * 1. array: scripts that are already uploaded 2. array: scripts that user marked to force upload.
 */
export async function ensureForceUpload(conf: vscode.WorkspaceConfiguration, scripts: nodeDoc.scriptT[]): Promise<[nodeDoc.scriptT[], nodeDoc.scriptT[]]> {
    return new Promise<[nodeDoc.scriptT[], nodeDoc.scriptT[]]>((resolve, reject) => {
        const forceUpload: nodeDoc.scriptT[] = [];
        const noConflict: nodeDoc.scriptT[] = [];

        let all = conf.get('forceUpload', false);
        let none = false;
        const singlescript = (1 === scripts.length);
        const categories = conf.get('categories', false);

        // todo: using async/await here probably makes the whole procedure
        // a bit simpler
        return reduce(scripts, (numScripts: number, script: any): Promise<number> => {
            return askForUpload(script, all, none, singlescript, categories).then((value) => {
                if (NO_CONFLICT === value) {
                    noConflict.push(script);
                } else if (FORCE_UPLOAD_ALL === value) {
                    script.forceUpload = true;
                    script.conflict = 0;
                    forceUpload.push(script);
                    all = true;
                } else if (FORCE_UPLOAD_YES === value) {
                    script.forceUpload = true;
                    script.conflict = 0;
                    forceUpload.push(script);
                } else if (FORCE_UPLOAD_NO === value) {
                    // do nothing ...
                } else {
                    // escape or anything should behave as if the user answered 'None'
                    none = true;
                }
                return numScripts + 1;
            });
        }, 0).then(() => {
            resolve([noConflict, forceUpload]);
        });
    });
}


/**
 * Read from settings.json if the script must be uploaded.
 * If it's not set, ask user, if the script should be uploaded and if
 * the answer should be saved. If so, save it to settings.json.
 *
 * @param param script-name or -path
 */
export async function ensureUploadOnSave(conf: vscode.WorkspaceConfiguration, param: string): Promise<helpers.autoUpload> {
    return new Promise<helpers.autoUpload>((resolve, reject) => {
        let always: string[] = [];
        let never: string[] = [];

        if (0 === param.length) {
            return reject('Scriptname is missing');
        }

        const scriptname = path.basename(param, '.js');

        const _always = conf.get('uploadOnSave');
        const _never = conf.get('uploadManually');
        if (_always instanceof Array && _never instanceof Array) {
            always = _always;
            never = _never;
        } else {
            vscode.window.showWarningMessage('Cannot read upload mode from settings.json');
            return reject();
        }
        if (0 <= never.indexOf(scriptname)) {
            resolve(helpers.autoUpload.no);
        } else if (0 <= always.indexOf(scriptname)) {
            resolve(helpers.autoUpload.yes);
        } else {
            const QUESTION: string = `Upload script ${scriptname}?`;
            const YES: string = `Yes`;
            const NO: string = `No`;
            const ALWAYS: string = `Always upload ${scriptname} automatically`;
            const NEVER: string = `Never upload ${scriptname} automatically`;
            const NEVERASK: string = `Never upload scripts automatically`;
            vscode.window.showQuickPick([YES, NO, ALWAYS, NEVER, NEVERASK], { placeHolder: QUESTION }).then((answer) => {
                if (YES === answer) {
                    resolve(helpers.autoUpload.yes);
                } else if (NO === answer) {
                    resolve(helpers.autoUpload.no);
                } else if (ALWAYS === answer) {
                    always.push(scriptname);
                    conf.update('uploadOnSave', always);
                    resolve(helpers.autoUpload.yes);
                } else if (NEVER === answer) {
                    never.push(scriptname);
                    conf.update('uploadManually', never);
                    resolve(helpers.autoUpload.no);
                } else if (NEVERASK === answer) {
                    conf.update('uploadOnSaveGlobal', false, true);
                    resolve(helpers.autoUpload.neverAsk);
                }
            });
        }
    });
}

export function setScriptInfoJson(conf: vscode.WorkspaceConfiguration, scripts: nodeDoc.scriptT[]) {
    if (!vscode.workspace.rootPath) {
        return;
    }
    const scriptParameters = conf.get('scriptParameters', false);
    if (!scriptParameters) {
        return;
    }
    // loginData.language = nodeDoc.Language.English;

    const rootPath = vscode.workspace.rootPath;
    scripts.forEach((script) => {
        const infoFile = path.join(rootPath, '.scriptParameters', script.name + '.json');
        try {
            script.parameters = fs.readFileSync(infoFile, 'utf8');
        } catch (err) {
            //
        }
    });
}

export function getScriptInfoJson(conf: vscode.WorkspaceConfiguration, scripts: nodeDoc.scriptT[]) {
    const scriptParameters = conf.get('scriptParameters', false);
    if (!scriptParameters) {
        return;
    }
    // loginData.language = nodeDoc.Language.English;

    scripts.forEach((script) => {
        script.downloadParameters = true;
    });
}

export async function writeScriptInfoJson(conf: vscode.WorkspaceConfiguration, scripts: nodeDoc.scriptT[]) {
    if (!vscode.workspace.rootPath) {
        return;
    }
    const scriptParameters = conf.get('scriptParameters', false);
    if (!scriptParameters) {
        return;
    }
    const rootPath = vscode.workspace.rootPath;
    scripts.forEach(async (script) => {
        if (script.parameters) {
            const parpath = path.join(rootPath, '.scriptParameters', script.name + '.json');
            await nodeDoc.writeFileEnsureDir(script.parameters, parpath);
        }
    });
}


export function readEncryptionFlag(conf: vscode.WorkspaceConfiguration, pscripts: nodeDoc.scriptT[]) {
    if (0 === pscripts.length) {
        return;
    }

    // write values
    const encryptOnUpload = conf.get('encryptOnUpload');
    const encryptionOnUpload = conf.get('encryptionOnUpload');
    if (encryptOnUpload) {
        pscripts.forEach((script) => {
            script.encrypted = 'decrypted';
        });
    } else if (encryptionOnUpload) {
        switch (encryptionOnUpload) {
            case "always":
                pscripts.forEach((script) => {
                    script.encrypted = 'decrypted';
                });
                break;

            case "never":
                pscripts.forEach((script) => {
                    script.encrypted = 'forceFalse';
                });
                break;

            case "default":
            default:
                pscripts.forEach((script) => {
                    script.encrypted = 'false';
                });
                break;
            }
    } else {
        pscripts.forEach((script) => {
            script.encrypted = 'false';
        });
    }
}



export function setConflictModes(conf: vscode.WorkspaceConfiguration, pscripts: nodeDoc.scriptT[]) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }
    if (!vscode.workspace) {
        return;
    }

    const forceUpload = conf.get('forceUpload', false);

    // read values
    pscripts.forEach((script) => {
        if (forceUpload) {
            script.conflictMode = false;
        }
    });
}

/**
 * Reads the conflict mode and hash value of any script in pscripts.
 */
export function readHashValues(conf: vscode.WorkspaceConfiguration, pscripts: nodeDoc.scriptT[], server: string) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }

    if (!vscode.workspace.rootPath) {
        return;
    }

    if (conf.get('vscode-janus-debug.forceUpload', false)) {
        return;
    }

    // filename of cache file CACHE_FILE
    const hashValueFile = path.join(vscode.workspace.rootPath, helpers.CACHE_FILE);

    // get hash values from file as array
    let hashValues: string[];
    try {
        hashValues = fs.readFileSync(hashValueFile, 'utf8').trim().split('\n');
    } catch (err) {
        if (err.code === 'ENOENT') {
            hashValues = [];
            fs.writeFileSync(hashValueFile, '');
        } else {
            return;
        }
    }


    // read hash values of scripts in conflict mode
    pscripts.forEach((script) => {
        hashValues.forEach((value, idx) => {
            const scriptpart = value.split(':')[0];
            const scriptAtServer = script.name + '@' + server;

            if (scriptpart === scriptAtServer) {
                script.lastSyncHash = hashValues[idx].split(':')[1];
            }
        });
    });
}

export function updateHashValues(conf: vscode.WorkspaceConfiguration, pscripts: nodeDoc.scriptT[], server: string) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }
    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return;
    }

    if (conf.get('vscode-janus-debug.forceUpload', false)) {
        return;
    }

    // filename of cache file CACHE_FILE
    const hashValueFile = path.join(vscode.workspace.rootPath, helpers.CACHE_FILE);

    let hashValues: string[];
    try {
        // get hash values from file as array
        hashValues = fs.readFileSync(hashValueFile, 'utf8').trim().split('\n');
    } catch (err) {
        if (err.code === 'ENOENT') {
            hashValues = [];
            fs.writeFileSync(hashValueFile, '');
        } else {
            return;
        }
    }

    // set hash values of scripts in conflict mode
    pscripts.forEach((script) => {

        const scriptAtServer = script.name + '@' + server;
        const entry = scriptAtServer + ':' + script.lastSyncHash;

        // search entry
        let updated = false;
        hashValues.forEach((value, idx) => {
            const scriptpart = value.split(':')[0];
            if (scriptpart === scriptAtServer) {
                hashValues[idx] = entry;
                updated = true;
            }
        });

        // create new entry
        if (!updated) {
            hashValues.push(entry);
        }
    });

    // write to CACHE_FILE
    const hashValStr = hashValues.join('\n').trim();
    fs.writeFileSync(hashValueFile, hashValStr);
}


export function scriptLog(conf: vscode.WorkspaceConfiguration, scriptOutput: string | undefined) {
    if (!scriptOutput || 0 >= scriptOutput.length) {
        return;
    }
    const log: any = conf.get('scriptLog');
    if (!log || !log.returnValue) {
        return;
    }
    let returnValue = '';
    const lines = scriptOutput.replace('\r', '').split('\n');
    lines.forEach(function(line) {
        if (line.startsWith('Return-Value: ')) {
            returnValue = line.substr(14) + os.EOL;
        }
    });
    if (returnValue.length > 0 && log.fileName && vscode.workspace.rootPath) {
        const fileName = log.fileName.replace(/[$]{workspaceRoot}/, vscode.workspace.rootPath);
        if (conf.get('scriptLog.append', false)) {
            fs.writeFileSync(fileName, returnValue, {flag: "a"});
        } else {
            fs.writeFileSync(fileName, returnValue);
        }
    }
}