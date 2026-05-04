import type { HeroSlide } from '@/entities/site/model/defaultSlides';

import { query } from './client';
import { ensureSiteSchema } from './schema';

type SlideRow = {
  id: string | number;
  title: string;
  image_url: string;
  tablet_image_url: string | null;
  mobile_image_url: string | null;
  popup_image_url: string | null;
  popup_tablet_image_url: string | null;
  popup_mobile_image_url: string | null;
  popup_title: string | null;
  popup_text: string | null;
  link_url: string | null;
  sort_order: number;
  is_active: boolean;
};

function mapSlide(row: SlideRow): HeroSlide {
  return {
    id: Number(row.id),
    title: row.title,
    imageUrl: row.image_url,
    tabletImageUrl: row.tablet_image_url,
    mobileImageUrl: row.mobile_image_url,
    popupImageUrl: row.popup_image_url,
    popupTabletImageUrl: row.popup_tablet_image_url,
    popupMobileImageUrl: row.popup_mobile_image_url,
    popupTitle: row.popup_title,
    popupText: row.popup_text,
    linkUrl: row.link_url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export async function getHeroSlides({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<SlideRow>(
    `select id, title, image_url, tablet_image_url, mobile_image_url,
            popup_image_url, popup_tablet_image_url, popup_mobile_image_url, popup_title, popup_text,
            link_url, sort_order, is_active
     from hero_slides
     ${activeOnly ? 'where is_active = true' : ''}
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapSlide);
}

export async function createHeroSlide(slide: Omit<HeroSlide, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into hero_slides (
       title, image_url, tablet_image_url, mobile_image_url,
       popup_image_url, popup_tablet_image_url, popup_mobile_image_url, popup_title, popup_text,
       link_url, sort_order, is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      slide.title,
      slide.imageUrl,
      slide.tabletImageUrl || null,
      slide.mobileImageUrl || null,
      slide.popupImageUrl || null,
      slide.popupTabletImageUrl || null,
      slide.popupMobileImageUrl || null,
      slide.popupTitle || null,
      slide.popupText || null,
      slide.linkUrl || null,
      slide.sortOrder,
      slide.isActive,
    ],
  );
  return Number(result.rows[0].id);
}

export async function updateHeroSlide(id: number, slide: Partial<Omit<HeroSlide, 'id'>>) {
  await ensureSiteSchema();
  await query(
    `update hero_slides
     set title = coalesce($2, title),
         image_url = coalesce($3, image_url),
         tablet_image_url = $4,
         mobile_image_url = $5,
         popup_image_url = $6,
         popup_tablet_image_url = $7,
         popup_mobile_image_url = $8,
         popup_title = $9,
         popup_text = $10,
         link_url = $11,
         sort_order = coalesce($12, sort_order),
         is_active = coalesce($13, is_active),
         updated_at = now()
     where id = $1`,
    [
      id,
      slide.title ?? null,
      slide.imageUrl ?? null,
      slide.tabletImageUrl ?? null,
      slide.mobileImageUrl ?? null,
      slide.popupImageUrl ?? null,
      slide.popupTabletImageUrl ?? null,
      slide.popupMobileImageUrl ?? null,
      slide.popupTitle ?? null,
      slide.popupText ?? null,
      slide.linkUrl ?? null,
      slide.sortOrder ?? null,
      slide.isActive ?? null,
    ],
  );
}

export async function deleteHeroSlide(id: number) {
  await ensureSiteSchema();
  await query(`delete from hero_slides where id = $1`, [id]);
}
