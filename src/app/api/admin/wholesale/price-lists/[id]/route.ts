import {
  deleteWholesalePriceList,
  getWholesalePriceListEditor,
  updateWholesalePriceList,
  type WholesalePriceListItemInput,
} from '@/shared/lib/db';
import { requireEmployee } from '@/shared/lib/adminAuth';

type Context = {
  params: Promise<{ id: string }>;
};

function itemsFromBody(items: unknown): WholesalePriceListItemInput[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const source = item as Record<string, unknown>;
      const productId = Number(source.productId);
      if (!Number.isInteger(productId)) return null;
      const variantId = source.variantId === null || source.variantId === undefined ? null : Number(source.variantId);
      return {
        productId,
        variantId: Number.isInteger(variantId) ? variantId : null,
        customWholesalePrice:
          typeof source.customWholesalePrice === 'string' && source.customWholesalePrice.trim()
            ? source.customWholesalePrice.trim()
            : null,
        visible: Boolean(source.visible),
        sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : index + 1,
      };
    })
    .filter(Boolean) as WholesalePriceListItemInput[];
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const priceList = await getWholesalePriceListEditor(numericId, session);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ priceList });
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  await updateWholesalePriceList(
    numericId,
    {
      title,
      clientName: typeof body.clientName === 'string' ? body.clientName.trim() : '',
      managerId: Number.isFinite(Number(body.managerId)) ? Number(body.managerId) : null,
      validUntil: typeof body.validUntil === 'string' ? body.validUntil : null,
      token: typeof body.token === 'string' ? body.token.trim() : '',
      comment: typeof body.comment === 'string' ? body.comment.trim() : '',
      showRetailPrices: Boolean(body.showRetailPrices),
      isActive: Boolean(body.isActive ?? true),
      items: itemsFromBody(body.items),
    },
    session,
  );

  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesalePriceList(numericId, session);
  return Response.json({ ok: true });
}
