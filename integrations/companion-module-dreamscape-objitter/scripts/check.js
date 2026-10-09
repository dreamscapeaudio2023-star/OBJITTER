// Loads src/main.js with a stand-in for @companion-module/base and runs the instance lifecycle
// (init → config change → destroy) to catch wiring errors without a running Companion.
// Run: node scripts/check.js
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const real = require('@companion-module/base')
const calls = []
let Instance = null
class FakeBase {
	constructor() {
		this.label = 'objitter'
	}
	log(level, msg) {
		calls.push(['log', level, msg])
	}
	updateStatus(status, msg) {
		calls.push(['status', status, msg])
	}
	setActionDefinitions(d) {
		calls.push(['actions', Object.keys(d).length])
	}
	setFeedbackDefinitions(d) {
		calls.push(['feedbacks', Object.keys(d).length])
	}
	setVariableDefinitions(d) {
		calls.push(['variableDefs', d.length])
	}
	setPresetDefinitions(d) {
		calls.push(['presets', Object.keys(d).length])
	}
	setVariableValues(v) {
		calls.push(['vars', v])
	}
	checkFeedbacks() {
		calls.push(['checkFeedbacks'])
	}
	async parseVariablesInString(s) {
		return s
	}
}
const stub = { ...real, InstanceBase: FakeBase, runEntrypoint: (cls, upgrades) => ((Instance = cls), assert.ok(Array.isArray(upgrades))) }
const origLoad = Module._load
Module._load = function (request, ...rest) {
	return request === '@companion-module/base' ? stub : origLoad.call(this, request, ...rest)
}
require(path.join(__dirname, '../src/main.js'))
assert.ok(Instance, 'runEntrypoint called')

;(async () => {
	const inst = new Instance({})
	const fields = inst.getConfigFields()
	assert.deepEqual(fields.map((f) => f.id), ['info', 'host', 'controlPort', 'webPort', 'feedback'])
	const defaults = Object.fromEntries(fields.filter((f) => 'default' in f).map((f) => [f.id, f.default]))
	assert.deepEqual(defaults, { host: '127.0.0.1', controlPort: 9000, webPort: 8080, feedback: true })

	await inst.init({ host: '127.0.0.1', controlPort: 9, webPort: 1, feedback: false })
	assert.ok(calls.some((c) => c[0] === 'status' && c[1] === real.InstanceStatus.Ok))
	assert.ok(calls.some((c) => c[0] === 'actions' && c[1] > 30))
	assert.ok(calls.some((c) => c[0] === 'presets' && c[1] > 60))
	const firstVars = calls.find((c) => c[0] === 'vars')[1]
	assert.equal(firstVars.connection, 'off')

	await inst.configUpdated({ host: '', controlPort: 9000, webPort: 8080, feedback: true })
	assert.ok(calls.some((c) => c[0] === 'status' && c[1] === real.InstanceStatus.BadConfig))

	await inst.configUpdated({ host: '127.0.0.1', controlPort: 9, webPort: 1, feedback: true })
	await new Promise((r) => setTimeout(r, 1500))
	assert.ok(calls.some((c) => c[0] === 'status' && c[1] === real.InstanceStatus.ConnectionFailure), 'unreachable web port reported')
	await inst.destroy()
	console.log('ok - main.js lifecycle (stubbed Companion)')
})().catch((err) => {
	console.error(err)
	process.exit(1)
})
