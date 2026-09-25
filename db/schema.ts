import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// No user, session, IP, search term or selected-address fields.
export const jobClicks = sqliteTable('job_clicks', {
  eventId: text('event_id').primaryKey(),
  clickedAt: integer('clicked_at').notNull(),
  source: text('source', { enum: ['albamon', 'daangn', 'alba'] }).notNull(),
  jobKey: text('job_key').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  company: text('company').notNull()
}, (table) => [index('idx_job_clicks_clicked_at').on(table.clickedAt)]);
