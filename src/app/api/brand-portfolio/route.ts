import { getBrandPortfolio } from '@/shared/lib/db';

export async function GET() {
  const portfolio = await getBrandPortfolio({ activeOnly: true });
  return Response.json(portfolio);
}
