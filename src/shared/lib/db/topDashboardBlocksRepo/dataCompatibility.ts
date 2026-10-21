import {
  TopDashboardActiveHtmlRequiredError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
  type TopDashboardProfile,
  type TopDashboardSnapshotFormat,
} from '../topDashboardDomain';
import { TopDashboardBlockStateNotFoundError } from './types';
import { numericId, type Queryable } from './records';
import { detectTopDashboardDataContract } from '../../topDashboardContentSecurity';

export function assertDashboardDataCompatibility(input: {
  htmlVersionId: number;
  htmlSnapshotFormat: TopDashboardSnapshotFormat | null;
  htmlProfile: TopDashboardProfile | null;
  dataSnapshotFormat: TopDashboardSnapshotFormat;
  dataProfile: TopDashboardProfile;
  dataBoundHtmlVersionId: number | null;
  action: 'html' | 'data';
}) {
  if (!input.htmlSnapshotFormat || !input.htmlProfile) {
    throw new TopDashboardDataCompatibilityError(
      input.action === 'html'
        ? 'Нельзя опубликовать HTML: не удалось определить подходящий тип данных'
        : 'Для опубликованной HTML-страницы не удалось определить подходящий тип данных',
    );
  }
  assertValidDashboardDataContract(input.htmlSnapshotFormat, input.htmlProfile);
  const htmlIsGeneric =
    input.htmlSnapshotFormat === 'multi-file-v1' && input.htmlProfile === 'generic';
  const dataIsGeneric =
    input.dataSnapshotFormat === 'multi-file-v1' && input.dataProfile === 'generic';
  const dataContractIsValid =
    (input.dataSnapshotFormat === 'purchases-v1' && input.dataProfile === 'purchases')
    || (
      input.dataSnapshotFormat === 'kts-bundle-v1'
      && (
        input.dataProfile === 'sales-analytics'
        || input.dataProfile === 'assortment-optimization'
      )
    )
    || dataIsGeneric;

  if (
    !dataContractIsValid
    || input.htmlSnapshotFormat !== input.dataSnapshotFormat
    || input.htmlProfile !== input.dataProfile
    || htmlIsGeneric !== dataIsGeneric
    || (dataIsGeneric && input.dataBoundHtmlVersionId !== input.htmlVersionId)
    || (!dataIsGeneric && input.dataBoundHtmlVersionId !== null)
  ) {
    throw new TopDashboardDataCompatibilityError(
      input.action === 'html'
        ? 'Нельзя опубликовать HTML: он не подходит к текущим данным'
        : 'Этот файл данных не подходит для опубликованной HTML-страницы',
    );
  }
}

export function isGenericDashboardDataContract(
  snapshotFormat: TopDashboardSnapshotFormat | null,
  profile: TopDashboardProfile | null,
) {
  return snapshotFormat === 'multi-file-v1' && profile === 'generic';
}

export function assertValidDashboardDataContract(
  snapshotFormat: TopDashboardSnapshotFormat | null,
  profile: TopDashboardProfile | null,
) {
  const valid =
    (snapshotFormat === 'purchases-v1' && profile === 'purchases')
    || (
      snapshotFormat === 'kts-bundle-v1'
      && (profile === 'sales-analytics' || profile === 'assortment-optimization')
    )
    || isGenericDashboardDataContract(snapshotFormat, profile);

  if (!valid) {
    throw new TopDashboardDataCompatibilityError(
      'Для HTML-страницы не удалось определить поддерживаемый тип данных',
    );
  }
}

export function dashboardDataContextKey(
  snapshotFormat: TopDashboardSnapshotFormat,
  profile: TopDashboardProfile,
  htmlVersionId: number,
) {
  return isGenericDashboardDataContract(snapshotFormat, profile)
    ? `html:${htmlVersionId}`
    : `${snapshotFormat}:${profile}`;
}

export async function assertExpectedActiveHtmlVersion(
  client: Queryable,
  blockId: number,
  expectedActiveHtmlVersionId: number,
  expectedSnapshotFormat: TopDashboardSnapshotFormat,
  expectedProfile: TopDashboardProfile,
) {
  const stateResult = await client.query<{ active_version_id: string | null; html_content: string | null }>(
    `select state.active_version_id::text, version.html_content
     from top_dashboard_block_state state
     left join top_dashboard_block_versions version
       on version.block_id = state.block_id and version.id = state.active_version_id
     where state.block_id = $1
     for update of state`,
    [blockId],
  );
  const state = stateResult.rows[0];
  if (!state) throw new TopDashboardBlockStateNotFoundError();

  const activeHtmlVersionId = numericId(state.active_version_id);
  if (activeHtmlVersionId !== expectedActiveHtmlVersionId) {
    throw new TopDashboardStateConflictError(activeHtmlVersionId);
  }
  if (activeHtmlVersionId === null) throw new TopDashboardActiveHtmlRequiredError();
  const contract = state.html_content === null ? null : detectTopDashboardDataContract(state.html_content);
  if (!contract || contract.mode === 'disabled'
    || contract.snapshotFormat !== expectedSnapshotFormat || contract.profile !== expectedProfile) {
    throw new TopDashboardDataCompatibilityError('Для этого HTML общие данные не подключены или режим изменился');
  }
}
