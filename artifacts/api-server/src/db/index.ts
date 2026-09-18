import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { schemaSql } from "./schema";

export type Role = "citizen" | "collector" | "admin";
export type AuthUser = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: Role;
  status: "active" | "inactive" | "suspended";
  address: string | null;
  zone: string | null;
  initials: string;
};

export async function migrateAndSeed() {
  await pool.query(schemaSql);
  const existing = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  if (existing.rows[0]?.count > 0) return;

  const passwordHash = await bcrypt.hash("WasteDemo#2026", 12);
  const zone = await pool.query(
    "INSERT INTO zones (name, code, description) VALUES ($1, $2, $3) RETURNING id",
    ["Central Ward", "CW-01", "Central municipal service zone"],
  );
  const zoneId = zone.rows[0].id as string;
  const users = await pool.query(
    `INSERT INTO users (full_name, email, phone, password_hash, role, address, zone_id)
     VALUES
       ('Anika Rao', 'admin@example.com', '+91 90000 10001', $1, 'admin', 'Municipal Operations Centre', $2),
       ('Ravi Kumar', 'collector@example.com', '+91 90000 10002', $1, 'collector', 'Central Ward Depot', $2),
       ('Maya Iyer', 'citizen@example.com', '+91 90000 10003', $1, 'citizen', '14 Lakeview Road', $2)
     RETURNING id, email`,
    [passwordHash, zoneId],
  );
  const collectorId = users.rows.find((row) => row.email === "collector@example.com").id as string;
  const citizenId = users.rows.find((row) => row.email === "citizen@example.com").id as string;
  const point = await pool.query(
    "INSERT INTO collection_points (zone_id, name, address) VALUES ($1, $2, $3) RETURNING id",
    [zoneId, "Lakeview Community Point", "14 Lakeview Road, Central Ward"],
  );
  const schedule = await pool.query(
    `INSERT INTO collection_schedules (zone_id, collection_point_id, waste_type, collection_date, start_time, end_time)
     VALUES ($1, $2, 'wet', CURRENT_DATE, '07:00', '09:00') RETURNING id`,
    [zoneId, point.rows[0].id],
  );
  await pool.query(
    "INSERT INTO collection_assignments (schedule_id, collector_id, status) VALUES ($1, $2, 'assigned')",
    [schedule.rows[0].id, collectorId],
  );
  const complaint = await pool.query(
    `INSERT INTO complaints (citizen_id, category, title, description, location, severity, status)
     VALUES ($1, 'overflowing_bin', 'Bin near Lakeview is almost full', 'The community bin is above the safe fill line and needs a pickup before the evening.', 'Lakeview Community Point', 'high', 'acknowledged')
     RETURNING id`,
    [citizenId],
  );
  await pool.query(
    "INSERT INTO complaint_status_history (complaint_id, changed_by, new_status, note) VALUES ($1, $2, 'submitted', 'Report received')",
    [complaint.rows[0].id, citizenId],
  );
  await pool.query(
    "INSERT INTO complaint_status_history (complaint_id, changed_by, new_status, note) VALUES ($1, $2, 'acknowledged', 'Operations team has acknowledged the report')",
    [complaint.rows[0].id, users.rows.find((row) => row.email === "admin@example.com").id],
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES
       ($1, 'collection', 'Collection scheduled today', 'Wet waste collection is scheduled between 07:00 and 09:00 at Lakeview Community Point.'),
       ($1, 'complaint', 'Complaint acknowledged', 'Your overflow report has been acknowledged by the operations team.')`,
    [citizenId],
  );
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function publicUser(row: Record<string, unknown>): AuthUser {
  const name = String(row.full_name ?? "");
  return {
    id: String(row.id),
    fullName: name,
    email: String(row.email),
    phone: row.phone ? String(row.phone) : null,
    role: row.role as Role,
    status: row.status as AuthUser["status"],
    address: row.address ? String(row.address) : null,
    zone: row.zone_name ? String(row.zone_name) : null,
    initials: name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
  };
}