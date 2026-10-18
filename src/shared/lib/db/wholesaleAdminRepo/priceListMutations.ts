import type { AdminSession } from '@/shared/lib/adminAuth';
import { assertRecordRevision } from '@/shared/lib/recordVersion';
import { getWholesalePriceListAccessScope, resolveWholesalePriceListManagerAssignment } from '@/shared/lib/wholesalePriceListAccess';
import { getWholesalePriceWorkflowStatusLabel, normalizeWholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';
import { trackAnalyticsEvent } from '../analyticsRepo';
import { query, withTransaction } from '../client';
import { ensureSiteSchema } from '../schema';
import { actorMeta, actorTypeFromRole, clientIdFromName, priceListAction, priceListDetails } from './analyticsHelpers';
import { lockPriceListCompany, writePriceListCompanyAssignment } from './priceListCompanyWrite';
import { replaceWholesalePriceListGroupStockSettings, upsertWholesalePriceListItems, type PriceListWriteQuery } from './priceListWrite';
import { writePriceListEventRow, priceListEventAnalytics, insertPriceListEvent, type PriceListEventInput } from './eventWrites';
import type { WholesalePriceListEditor } from './types';

export async function createWholesalePriceList(
  input: Omit<WholesalePriceListEditor, 'id' | 'revision'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const assignment = resolveWholesalePriceListManagerAssignment(input, session);
  const managerId = assignment.managerId;
  const supportManagerId = assignment.supportManagerId;
  const actor = actorMeta(session);
  const { id, event, clientCompany } = await withTransaction(async (client) => {
    const clientCompany = await lockPriceListCompany(client, input.clientCompanyId, assignment, session);
    const execute: PriceListWriteQuery = (text, params) => client.query(text, params);
    const result = await client.query<{ id: string }>(
      `insert into wholesale_price_lists (
         title, client_company_id, client_name, manager_id, support_manager_id, valid_until, token, comment, workflow_status, show_retail_prices, show_stock, show_stock_text, is_active
       )
       values ($1, $2, $3, $4, $5, nullif($6, '')::date, $7, $8, $9, $10, $11, $12, $13)
       returning id`,
      [
        input.title, clientCompany.id, clientCompany.title, managerId, supportManagerId,
        input.validUntil ?? '', input.token, input.comment, input.workflowStatus,
        input.showRetailPrices, input.showStock, input.showStockText, input.isActive,
      ],
    );
    const id = Number(result.rows[0].id);
    await upsertWholesalePriceListItems(execute, id, input.items);
    await replaceWholesalePriceListGroupStockSettings(execute, id, input.priceGroupStockSettings);
    const event: PriceListEventInput = {
      priceListId: id,
      ownerManagerId: managerId,
      actorManagerId: actor.actorManagerId,
      actorRole: actor.actorRole,
      title: input.title,
      action: 'create',
      details: 'Прайс создан',
    };
    await writePriceListEventRow(event, execute);
    await writePriceListCompanyAssignment(client, clientCompany.id, assignment);
    return { id, event, clientCompany };
  });
  // Analytics uses the global pool and must run only after the parent price list commits.
  await trackAnalyticsEvent(priceListEventAnalytics(event));
  await trackAnalyticsEvent({
    eventType: 'price_public_link_created',
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: input.token,
    metadata: {
      title: input.title,
      clientCompanyId: clientCompany.id,
      clientName: clientCompany.title,
    },
  });
  return id;
}

export async function updateWholesalePriceList(
  id: number,
  input: Omit<WholesalePriceListEditor, 'id' | 'revision'> & { expectedRevision: string },
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  const assignment = resolveWholesalePriceListManagerAssignment(input, session);
  const managerId = assignment.managerId;
  const supportManagerId = assignment.supportManagerId;
  const actor = actorMeta(session);
  const { previousRow, previousVisibleItems, nextVisibleItems, event, clientCompany, nextInput, revision } = await withTransaction(async (client) => {
    const clientCompany = await lockPriceListCompany(client, input.clientCompanyId, assignment, session);
    const nextInput = { ...input, clientCompanyId: clientCompany.id, clientName: clientCompany.title };
    const execute: PriceListWriteQuery = (text, params) => client.query(text, params);
    const previous = await client.query<{
      revision: string;
      title: string;
      client_name: string;
      manager_id: string | null;
      valid_until: string | null;
      workflow_status: string | null;
      is_active: boolean;
    }>(
      `select revision::text, title, client_name, manager_id::text, valid_until::text, workflow_status, is_active
       from wholesale_price_lists
       where id = $1
         and (
           $2::bigint is null
           or ($3::text = 'manager' and manager_id = $2)
           or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
         )
       limit 1
       for update`,
      [id, scope.managerId, scope.role],
    );
    const previousRow = previous.rows[0];
    if (!previousRow) throw new Error('Прайс не найден или недоступен. Обновите страницу.');
    assertRecordRevision(input.expectedRevision, previousRow.revision);
    const previousItems = await client.query<{ count: string }>(
      `select count(*)::text as count from wholesale_price_list_items where price_list_id = $1 and visible = true`,
      [id],
    );
    const previousVisibleItems = Number(previousItems.rows[0]?.count ?? 0);
    const updated = await client.query(
      `update wholesale_price_lists
       set title = $2,
           client_company_id = $3,
           client_name = $4,
           manager_id = $5,
           support_manager_id = $6,
           valid_until = nullif($7, '')::date,
           token = $8,
           comment = $9,
           workflow_status = $10,
           show_retail_prices = $11,
           show_stock = $12,
           show_stock_text = $13,
           is_active = $14,
           updated_at = now()
       where id = $1
         and (
           $15::bigint is null
           or ($16::text = 'manager' and manager_id = $15)
           or ($16::text = 'support_manager' and (support_manager_id = $15 or manager_id = $15))
         )`,
      [
        id, nextInput.title, clientCompany.id, clientCompany.title, managerId, supportManagerId,
        nextInput.validUntil ?? '', nextInput.token, nextInput.comment, nextInput.workflowStatus,
        nextInput.showRetailPrices, nextInput.showStock, nextInput.showStockText, nextInput.isActive,
        scope.managerId, scope.role,
      ],
    );
    if (updated.rowCount !== 1) throw new Error('Прайс не найден или недоступен. Обновите страницу.');
    await upsertWholesalePriceListItems(execute, id, nextInput.items);
    // Omitted positions remain stored. Count the committed-to-be state rather
    // than the request subset, otherwise a partial save falsely reports removal.
    const nextItems = await client.query<{ count: string }>(
      `select count(*)::text as count from wholesale_price_list_items where price_list_id = $1 and visible = true`,
      [id],
    );
    const nextVisibleItems = Number(nextItems.rows[0]?.count ?? 0);
    await replaceWholesalePriceListGroupStockSettings(execute, id, nextInput.priceGroupStockSettings);
    const event: PriceListEventInput = {
      priceListId: id,
      ownerManagerId: managerId,
      actorManagerId: actor.actorManagerId,
      actorRole: actor.actorRole,
      title: nextInput.title,
      action: priceListAction(previousRow, nextInput),
      details: priceListDetails(previousRow, nextInput),
    };
    await writePriceListEventRow(event, execute);
    await writePriceListCompanyAssignment(client, clientCompany.id, assignment);
    const saved = await client.query<{ revision: string }>('select revision::text from wholesale_price_lists where id = $1', [id]);
    return { previousRow, previousVisibleItems, nextVisibleItems, event, clientCompany, nextInput, revision: saved.rows[0].revision };
  });
  await trackAnalyticsEvent(priceListEventAnalytics(event));
  const baseEvent = {
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: nextInput.token,
  };
  if ((previousRow.client_name || '') !== nextInput.clientName) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_client_changed',
      clientId: clientIdFromName(nextInput.clientName),
      metadata: { from: previousRow.client_name, to: nextInput.clientName, title: nextInput.title, clientCompanyId: clientCompany.id },
    });
  }
  if ((previousRow.valid_until || '') !== (nextInput.validUntil || '')) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_expiration_changed',
      metadata: { from: previousRow.valid_until, to: nextInput.validUntil || null, title: nextInput.title },
    });
  }
  if (normalizeWholesalePriceWorkflowStatus(previousRow.workflow_status) !== nextInput.workflowStatus) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_status_changed',
      clientId: clientIdFromName(nextInput.clientName),
      metadata: {
        from: getWholesalePriceWorkflowStatusLabel(previousRow.workflow_status),
        to: getWholesalePriceWorkflowStatusLabel(nextInput.workflowStatus),
        title: nextInput.title,
        clientCompanyId: clientCompany.id,
        clientName: nextInput.clientName,
      },
    });
  }
  if (nextVisibleItems > previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_added',
      metadata: {
        added: nextVisibleItems - previousVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: nextInput.title,
      },
    });
  }
  if (nextVisibleItems < previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_removed',
      metadata: {
        removed: previousVisibleItems - nextVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: nextInput.title,
      },
    });
  }
  return revision;
}

export async function deleteWholesalePriceList(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  const previous = await query<{
    title: string;
    manager_id: string | null;
  }>(
    `select title, manager_id::text
     from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )
     limit 1`,
    [id, scope.managerId, scope.role],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;

  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: previousRow.manager_id ? Number(previousRow.manager_id) : null,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: previousRow.title,
    action: 'delete',
    details: 'Прайс удалён',
  });

  await query(
    `delete from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )`,
    [id, scope.managerId, scope.role],
  );
}
