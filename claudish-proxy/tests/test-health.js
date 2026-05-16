const assert = require('assert');
const { getCapabilityHealth } = require('../src/utils/health');

const health = getCapabilityHealth();

assert(health.generatedAt, 'health should include a generation timestamp');
assert(health.summary && ['ok', 'warn', 'error'].includes(health.summary.overall), 'health summary should have an overall status');
assert(Array.isArray(health.cards) && health.cards.length >= 4, 'health cards should be present');
assert(Array.isArray(health.checks) && health.checks.length > 0, 'health checks should be present');
assert(health.checks.some(check => check.id === 'august-brain'), 'August Brain health check should be present');
assert(health.checks.some(check => check.id === 'plugins'), 'plugin health check should be present');
assert(health.checks.some(check => check.id === 'mcp-blender'), 'Blender MCP health check should be present');

console.log('SUCCESS health');
