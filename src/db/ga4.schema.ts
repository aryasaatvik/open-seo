import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Selected Google Analytics property per project. The Google grant itself
// lives in the integration gateway (one org-level connection).
export const ga4Connections = sqliteTable(
  "ga4_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Canonical Admin API resource name, e.g. "properties/123456".
    propertyId: text("property_id").notNull(),
    propertyDisplayName: text("property_display_name").notNull(),
    propertyTimeZone: text("property_time_zone").notNull(),
    propertyCurrencyCode: text("property_currency_code").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ga4_connections_project_idx").on(table.projectId),
    index("ga4_connections_organization_idx").on(table.organizationId),
  ],
);
