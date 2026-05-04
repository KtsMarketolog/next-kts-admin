import { DEFAULT_HERO_SLIDES } from '@/entities/site/model/defaultSlides';
import { getHeroSlides } from '@/shared/lib/db';

export async function GET() {
  try {
    const slides = await getHeroSlides({ activeOnly: true });
    return Response.json({ slides });
  } catch {
    return Response.json({
      slides: DEFAULT_HERO_SLIDES.map((slide, index) => ({ id: index + 1, ...slide })),
    });
  }
}
