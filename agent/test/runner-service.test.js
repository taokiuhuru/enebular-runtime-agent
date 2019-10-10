/* @flow */
import test from 'ava'
import sinon from 'sinon'

import AgentCoreManager from '../lib/runner/agent-core-manager'
import AgentRunnerService from '../lib/runner/agent-runner-service'
import AgentRunnerLogger from '../lib/runner/agent-runner-logger'

test.before(async t => {
  process.env.ENEBULAR_TEST = true
  process.env.DEBUG = 'debug'
})

test.after(t => {
})

test.serial(
  'AgentRunnerService.1: send request response correctly',
  async t => {
    const agentCoreManager = new AgentCoreManager()
    const log = new AgentRunnerLogger(agentCoreManager)
    const agentRunnerService = new AgentRunnerService(agentCoreManager, log)

    let stub = sinon.stub(agentCoreManager, "sendResponse")

    let request = {
      type: "request",
      body: {
        id: "1",
        taskType: "remoteLoginStatusUpdate",
        settings: {}
      }
    }

    await agentRunnerService.onDataReceived(request)
    t.true(stub.called)
    let response = stub.args[0][0]
    t.true(response.success)

    request.type = 'wrong type'
    await agentRunnerService.onDataReceived(request)
    t.false(stub.calledTwice)

    request.type = 'request'
    request.body.taskType = "wrong task type"
    await agentRunnerService.onDataReceived(request)
    t.true(stub.calledTwice)
    response = stub.args[1][0]
    t.false(response.success)
    t.true(response.error.message === 'Unknown task type: wrong task type')
    t.true(response.error.code === 'ERR_INVALID_TYPE')

    delete request.body.settings
    request.body.taskType = "remoteLoginStatusUpdate"
    await agentRunnerService.onDataReceived(request)
    t.false(stub.calledThrice)
  }
)

test.serial(
  'AgentRunnerService.2: remoteLoginStatusUpdate triggers ssh status update',
  async t => {
    const agentCoreManager = new AgentCoreManager()
    const log = new AgentRunnerLogger(agentCoreManager)
    const agentRunnerService = new AgentRunnerService(agentCoreManager, log)

    const stub = sinon.stub(agentCoreManager, "sendStatusUpdate")

    await (agentRunnerService.onDataReceived({
      type: "request",
      body: {
        id: "1",
        taskType: "remoteLoginStatusUpdate",
        settings: {}
      }
    }))

    t.true(stub.called)
    t.deepEqual(stub.args[0][0], { type: 'sshServerStatusChanged', status: { active: false } })
    t.deepEqual(stub.args[1][0], { type: 'sshClientStatusChanged', status: { active: false } })
  }
)

test.serial(
  'AgentRunnerService.3: rotatePublicKey handles settings error',
  async t => {
    const agentCoreManager = new AgentCoreManager()
    const log = new AgentRunnerLogger(agentCoreManager)
    const agentRunnerService = new AgentRunnerService(agentCoreManager, log)

    const stub = sinon.stub(agentCoreManager, "sendResponse")

    let request = {
      type: "request",
      body: {
        id: "1",
        taskType: "rotatePublicKey",
        settings: {}
      }
    }

    await agentRunnerService.onDataReceived(request)
    t.true(stub.called)
    let response = stub.args[0][0]
    t.false(response.success)
    t.true(response.error.message === 'Invalid rotate settings')
    t.true(response.error.code === 'ERR_INVALID_PARAM')

    request.body.settings.id = "abcd.pub"
    await agentRunnerService.onDataReceived(request)
    t.true(stub.calledTwice)
    response = stub.args[1][0]
    t.false(response.success)
    t.true(response.error.message === 'Invalid rotate settings')
    t.true(response.error.code === 'ERR_INVALID_PARAM')

    request.body.settings.key = "key"
    await agentRunnerService.onDataReceived(request)
    t.true(stub.calledThrice)
    response = stub.args[2][0]
    t.false(response.success)
    t.true(response.error.message === 'Invalid rotate settings')
    t.true(response.error.code === 'ERR_INVALID_PARAM')

    request.body.settings.signature = "signature"
    await agentRunnerService.onDataReceived(request)
    response = stub.args[3][0]
    t.false(response.success)
    t.true(response.error.message === 'Invalid signature for public key')
    t.true(response.error.code === 'ERR_INVALID_SIGNATURE')
    t.true(Object.prototype.hasOwnProperty.call(response.error.info, 'publicKeyId'))
  }
)
