/* @flow */
import fs from 'fs';
import EventEmitter from 'events';
import path from 'path';
import { spawn, exec, type ChildProcess } from 'child_process';
import debug from 'debug';
import fetch from 'isomorphic-fetch';
import rfs from 'rotating-file-stream'
/**
 *
 */
const log = debug('enebular-runtime-agent:node-red-controller');
/**
 *
 */
type NodeRedFlowPackage = {
  flows: Object[],
  creds: Object,
  packages: Object,
};


/**
 *
 */
export default class NodeREDController {
  _dir: string;
  _command: string;
  _killSignal: string;
  _cproc: ?ChildProcess = null;
  _actions: Array<() => Promise<any>> = [];
  _isProcessing: ?Promise<void> = null;
  _currentFile: WritableStream

  constructor(dir: string, command: string, killSignal: string, emitter: EventEmitter) {
    this._dir = dir;    
    if (!fs.existsSync(this._dir)) {
      throw new Error(`Given Node RED dir is not found: ${this._dir}`);
    }
    if (!fs.existsSync(path.join(this._dir, 'package.json'))) {
      throw new Error(`Given Node RED dir does not have package.json file : ${this._dir}`);
    }
    this._command = command;
    this._killSignal = killSignal;
    this._registerHandler(emitter);
    this._currentFile = rfs(generator, {
      size: '1M',
      interval: '5s',
      path: 'logs',
      maxFiles: 100
    });
    this._stdoutUnhook = this._hookStream(process.stdout, (string, encoding) => {
      this._currentFile.write(string, encoding)
    })
    this._stderrUnhook = this._hookStream(process.stderr, (string, encoding) => {
      this._currentFile.write(string, encoding)
    })
  }

  _hookStream(stream, cb) {
    var old_write = stream.write
    stream.write = (function(write) {
      return function(string, encoding) {
        write.apply(stream, arguments)
        cb(string, encoding)
      }
    })(stream.write)
    return function() {
      stream.write = old_write
    }
  }

  _registerHandler(emitter: EventEmitter) {
    emitter.on('update-flow', (params) => this.fetchAndUpdateFlow(params));
    emitter.on('deploy', (params) => this.fetchAndUpdateFlow(params));
    emitter.on('start', () => this.startService());
    emitter.on('restart', () => this.restartService());
    emitter.on('shutdown', () => { this.shutdownService() });
  }

  async _queueAction(fn: () => Promise<any>) {
    log('_queueAction');
    this._actions.push(fn);
    if (this._isProcessing) {
      await this._isProcessing;
    } else {
      await this._processActions();
    }
  }

  async _processActions() {
    log('_processActions', this._actions.length);
    this._isProcessing = (async () => {
      while (this._actions.length > 0) {
        const action = this._actions.shift();
        await action();
      }
    })();
    await this._isProcessing;
    this._isProcessing = null;
  }

  async fetchAndUpdateFlow(params: { downloadUrl: string }) {
    return this._queueAction(() => this._fetchAndUpdateFlow(params));
  }

  async _fetchAndUpdateFlow(params: { downloadUrl: string }) {
    log('_fetchAndUpdateFlow', params);
    await this._downloadAndUpdatePackage(params.downloadUrl);
    await this._restartService();
  }

  async _downloadAndUpdatePackage(downloadUrl: string) {
    log('_downloadAndUpdatePackage', downloadUrl);
    const res = await fetch(downloadUrl);
    if (res.status >= 400) {
      throw new Error('invalid url');
    }
    const body = await res.json();
    return this._updatePackage(body);
  }

  async _updatePackage(flowPackage: NodeRedFlowPackage) {
    log('_updatePackage', flowPackage);
    const updates = [];
    if (flowPackage.flow || flowPackage.flows) {
      const flows = flowPackage.flow || flowPackage.flows;
      updates.push(
        new Promise((resolve, reject) => {
          const flowFilePath = path.join(this._dir, '.node-red-config', 'flows.json');
          fs.writeFile(flowFilePath, JSON.stringify(flows), (err) => err ? reject(err) : resolve());
        })
      );
    }
    if (flowPackage.cred || flowPackage.creds) {
      const creds = flowPackage.cred || flowPackage.creds;
      updates.push(
        new Promise((resolve, reject) => {
          const credFilePath = path.join(this._dir, '.node-red-config', 'flows_cred.json');
          fs.writeFile(credFilePath, JSON.stringify(creds), (err) => err ? reject(err) : resolve());
        })
      );
    }
    if (flowPackage.packages) {
      updates.push(
        new Promise((resolve, reject) => {
          const packageJSONFilePath = path.join(this._dir, '.node-red-config', 'enebular-agent-dynamic-deps', 'package.json');
          const packageJSON = JSON.stringify({
            name: 'enebular-agent-dynamic-deps',
            version: '0.0.1',
            dependencies: flowPackage.packages,
          }, null, 2);
          fs.writeFile(packageJSONFilePath, packageJSON, (err) => err ? reject(err) : resolve());
        })
      );
    }
    await Promise.all(updates);
    await this._resolveDependency();
  }

  async _resolveDependency() {
    return new Promise((resolve, reject) => {
      const cproc = spawn('npm', [ 'install', 'enebular-agent-dynamic-deps' ], { stdio: 'inherit', cwd: path.join(this._dir, '.node-red-config') });
      cproc.on('error', reject);
      cproc.once('exit', resolve);
    });
  }

  async startService() {
    return this._queueAction(() => this._startService());
  }

  async _startService() {
    log('_startService');
    return new Promise((resolve, reject) => {
      const [command, ...args] = this._command.split(/\s+/);
      const cproc = spawn(command, args, { stdio: 'pipe', cwd: this._dir });
      cproc.stdout.on('data', (data) => {
        process.stdout.write(data)
      });
      cproc.stderr.on('data', (data) => {
        process.stdout.write(data)
      });
      cproc.once('exit', (code) => {
        this._cproc = null;
      });
      cproc.once('error', (err) => {
        this._cproc = null;
        reject(err);
      });
      this._cproc = cproc;
      setTimeout(() => resolve(), 1000);
    });
  }

  async shutdownService() {
    return this._queueAction(() => this._shutdownService());
  }

  async _shutdownService() {
    log('_shutdownService');
    return new Promise((resolve, reject) => {
      const cproc = this._cproc;
      if (cproc) {
        cproc.kill(this._killSignal);
        cproc.once('exit', () => {
          this._cproc = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async restartService() {
    return this._queueAction(() => this._restartService());
  }

  async _restartService() {
    log('_restartService');
    await this._shutdownService();
    await this._startService();
  }

  getStatus() {
    log('_getStatus')
    if (this._cproc) {
      log('_getStatus connected')
      return 'connected';
    } else {
      log('_getStatus disconnected')
      return 'disconnected';
    }
  }
}

function pad(num) {
  return (num > 9 ? "" : "0") + num;
}

function generator(time, index) {
  if(! time)
      return "file.log";

  const month  = time.getFullYear() + "" + pad(time.getMonth() + 1);
  const day = pad(time.getDate());
  const hour = pad(time.getHours());
  const minute = pad(time.getMinutes());
  const seconds = pad(time.getSeconds());
  return `logs/${month}${day}${hour}${minute}${seconds}.log`
  // return month +
  //     day + "-" + hour + minute + "-" + seconds + "-" + index + "-file.log";
}