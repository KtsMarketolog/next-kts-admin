import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultTopDashboardIntegrationMode,
  normalizeTopDashboardDataContract,
  type TopDashboardOverview,
} from '../src/features/admin/top-dashboard/topDashboardManagementModel';

test('standalone contract cannot expose common data targets or snapshot format', () => {
  assert.deepEqual(normalizeTopDashboardDataContract({ htmlVersionId: 12, mode: 'disabled', profile: 'standalone',
    snapshotFormat: 'multi-file-v1', uploadTargets: [{ target: { id: 'invoice', name: null, index: 0 } }] }), {
    htmlVersionId: 12, mode: 'disabled', profile: 'standalone', snapshotFormat: null, directUploadTarget: null, uploadTargets: [],
  });
});

test('older unsupported-profitability response is displayed as local standalone instead of blocked', () => {
  assert.equal(normalizeTopDashboardDataContract({ htmlVersionId: 10, mode: 'disabled', profile: 'profitability-unsupported' }).profile, 'standalone');
  assert.equal(normalizeTopDashboardDataContract({ htmlVersionId: 10, mode: 'disabled', profile: 'profitability' }).profile, 'profitability');
});

test('new and local reports default to standalone; existing connected reports keep connected mode', () => {
  assert.equal(defaultTopDashboardIntegrationMode(null), 'standalone');
  for (const mode of ['disabled', 'legacy', 'generic'] as const) {
    const overview = { activeDataContract: { mode } } as TopDashboardOverview;
    assert.equal(defaultTopDashboardIntegrationMode(overview), mode === 'disabled' ? 'standalone' : 'connected');
  }
});
