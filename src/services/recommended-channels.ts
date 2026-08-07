import { z } from 'zod';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';

const username = z.string().trim().transform((value) => value
  .replace(/^https?:\/\/(?:www\.)?t\.me\//i, '')
  .replace(/^@/, '')
  .replace(/\/$/, '')
).pipe(z.string().regex(/^[A-Za-z0-9_]{5,32}$/, 'invalid Telegram username'));

const channelFields = {
  title: z.string().trim().min(2).max(120),
  username,
  description: z.string().trim().max(500),
  category: z.enum(['official', 'regional', 'monitoring', 'analytics']),
  locationId: z.string().trim().min(1).max(64).nullable(),
  verified: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000)
};

export const createChannelSchema = z.object(channelFields).strict();
export const updateChannelSchema = z.object({
  title: channelFields.title.optional(),
  username: channelFields.username.optional(),
  description: channelFields.description.optional(),
  category: channelFields.category.optional(),
  locationId: channelFields.locationId.optional(),
  verified: channelFields.verified.optional(),
  active: channelFields.active.optional(),
  sortOrder: channelFields.sortOrder.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'empty update');

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export async function listRecommendedChannels(locationId?: string | null, includeInactive = false) {
  const result = await pool.query(
    `${relatedLocationsCte('$2')}
     SELECT c.id,c.title,c.username,c.description,c.category,c.location_id,l.name_uk AS location_name,
            c.verified,c.active,c.sort_order,c.created_by,c.created_at,c.updated_at
     FROM recommended_telegram_channels c
     LEFT JOIN locations l ON l.id=c.location_id
     WHERE ($1::boolean OR c.active=true)
       AND ($2::text IS NULL OR c.location_id IS NULL
         OR EXISTS (SELECT 1 FROM related_locations r WHERE r.id=c.location_id))
     ORDER BY c.active DESC,c.verified DESC,c.sort_order,c.title`,
    [includeInactive, locationId ?? null]
  );
  return result.rows.map((row) => ({ ...row, url: `https://t.me/${row.username}` }));
}

export async function createRecommendedChannel(input: CreateChannelInput, createdBy: string) {
  const result = await pool.query(
    `INSERT INTO recommended_telegram_channels
      (title,username,description,category,location_id,verified,active,sort_order,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [input.title, input.username, input.description, input.category, input.locationId,
      input.verified, input.active, input.sortOrder, createdBy]
  );
  return result.rows[0];
}

export async function updateRecommendedChannel(id: string, input: UpdateChannelInput) {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columns: Record<keyof UpdateChannelInput, string> = {
    title: 'title', username: 'username', description: 'description', category: 'category',
    locationId: 'location_id', verified: 'verified', active: 'active', sortOrder: 'sort_order'
  };
  for (const [key, column] of Object.entries(columns) as Array<[keyof UpdateChannelInput, string]>) {
    if (input[key] === undefined) continue;
    values.push(input[key]); assignments.push(`${column}=$${values.length}`);
  }
  values.push(id);
  const result = await pool.query(
    `UPDATE recommended_telegram_channels SET ${assignments.join(',')},updated_at=now()
     WHERE id=$${values.length} RETURNING id`, values
  );
  return result.rows[0] ?? null;
}
