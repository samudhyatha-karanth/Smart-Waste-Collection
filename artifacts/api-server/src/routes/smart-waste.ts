import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import {
  AskWasteAssistantBody,
  CreateAdminZoneBody,
  CreateCitizenComplaintBody,
  GetAdminComplaintsQueryParams,
  GetAdminUsersQueryParams,
  GetCitizenComplaintParams,
  LoginBody,
  MarkCitizenNotificationReadParams,
  RegisterBody,
  UpdateAdminComplaintBody,
  UpdateAdminComplaintParams,
  UpdateAdminUserStatusBody,
  UpdateAdminUserStatusParams,
  UpdateCollectorAssignmentStatusBody,
  UpdateCollectorAssignmentStatusParams,
} from "@workspace/api-zod";
import { publicUser } from "../db";
import { createSession, destroySession, requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 1000 * 60 * 60 * 24 * 7,
};

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function sendError(res: Response, error: unknown) {
  if (error && typeof error === "object" && "issues" in error) {
    return res.status(400).json({ error: "Please check the submitted fields." });
  }
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

function scheduleRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    date: String(row.collection_date),
    time: `${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)}`,
    wasteType: String(row.waste_type),
    location: String(row.point_name),
    zone: String(row.zone_name),
    status: String(row.status ?? "scheduled"),
    collector: row.collector_name ? String(row.collector_name) : null,
  };
}

function complaintRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    description: String(row.description),
    location: String(row.location),
    severity: String(row.severity),
    status: String(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    citizenName: String(row.citizen_name),
    assignedCollector: row.collector_name ? String(row.collector_name) : null,
  };
}

const scheduleSelect = `
  SELECT s.id, s.collection_date, s.start_time, s.end_time, s.waste_type,
    z.name AS zone_name, cp.name AS point_name, ca.status,
    collector.full_name AS collector_name, ca.id AS assignment_id
  FROM collection_schedules s
  JOIN zones z ON z.id = s.zone_id
  JOIN collection_points cp ON cp.id = s.collection_point_id
  LEFT JOIN collection_assignments ca ON ca.schedule_id = s.id
  LEFT JOIN users collector ON collector.id = ca.collector_id
`;

router.post("/auth/login", async (req, res) => {
  try {
    const body = LoginBody.parse(req.body);
    const result = await pool.query("SELECT u.*, z.name AS zone_name FROM users u LEFT JOIN zones z ON z.id = u.zone_id WHERE LOWER(u.email) = LOWER($1)", [body.email]);
    const row = result.rows[0];
    if (!row || row.status !== "active" || !(await bcrypt.compare(body.password, row.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = await createSession(row.id);
    res.cookie("sws_session", token, cookieOptions);
    return res.json({ user: publicUser(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/auth/register", async (req, res) => {
  try {
    const body = RegisterBody.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const zone = body.zone
      ? await pool.query("SELECT id FROM zones WHERE LOWER(name) = LOWER($1) LIMIT 1", [body.zone])
      : { rows: [] };
    const result = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, address, zone_id)
       VALUES ($1, LOWER($2), $3, $4, 'citizen', $5, $6)
       RETURNING id, full_name, email, phone, role, status, address`,
      [body.fullName, body.email, body.phone, passwordHash, body.address, zone.rows[0]?.id ?? null],
    );
    const token = await createSession(result.rows[0].id);
    res.cookie("sws_session", token, cookieOptions);
    return res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    return sendError(res, error);
  }
});

router.post("/auth/logout", async (req, res) => {
  await destroySession(req.cookies?.sws_session);
  res.clearCookie("sws_session");
  return res.json({ message: "Signed out" });
});

router.get("/auth/me", requireAuth, (req, res) => res.json(req.user));

router.get("/citizen/dashboard", requireRole("citizen"), async (req, res) => {
  try {
    const [next, complaints, notifications, activity] = await Promise.all([
      pool.query(`${scheduleSelect} WHERE s.collection_date >= CURRENT_DATE AND z.id = (SELECT zone_id FROM users WHERE id = $1) ORDER BY s.collection_date, s.start_time LIMIT 1`, [req.user!.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM complaints WHERE citizen_id = $1 AND status NOT IN ('resolved','rejected')", [req.user!.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.user!.id]),
      pool.query("SELECT title, message AS description, created_at AS timestamp, 'green' AS tone FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5", [req.user!.id]),
    ]);
    return res.json({
      nextCollection: next.rows[0] ? scheduleRow(next.rows[0]) : null,
      openComplaints: complaints.rows[0].count,
      unreadNotifications: notifications.rows[0].count,
      tip: "Rinse food containers before placing them with dry recyclables. Keep batteries separate from all household waste.",
      recentActivity: activity.rows.map((row) => ({ ...row, timestamp: iso(row.timestamp) })),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/citizen/schedules", requireRole("citizen"), async (req, res) => {
  const result = await pool.query(`${scheduleSelect} WHERE z.id = (SELECT zone_id FROM users WHERE id = $1) ORDER BY s.collection_date DESC, s.start_time`, [req.user!.id]);
  return res.json(result.rows.map(scheduleRow));
});

router.get("/citizen/complaints", requireRole("citizen"), async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, citizen.full_name AS citizen_name, collector.full_name AS collector_name
     FROM complaints c JOIN users citizen ON citizen.id = c.citizen_id
     LEFT JOIN users collector ON collector.id = c.assigned_collector_id
     WHERE c.citizen_id = $1 ORDER BY c.created_at DESC`,
    [req.user!.id],
  );
  return res.json(result.rows.map(complaintRow));
});

router.post("/citizen/complaints", requireRole("citizen"), async (req, res) => {
  try {
    const body = CreateCitizenComplaintBody.parse(req.body);
    const result = await pool.query(
      `INSERT INTO complaints (citizen_id, category, title, description, location, latitude, longitude, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user!.id, body.category, body.title, body.description, body.location, body.latitude ?? null, body.longitude ?? null, body.severity],
    );
    await pool.query("INSERT INTO complaint_status_history (complaint_id, changed_by, new_status, note) VALUES ($1,$2,'submitted','Report received')", [result.rows[0].id, req.user!.id]);
    const joined = await pool.query("SELECT c.*, u.full_name AS citizen_name FROM complaints c JOIN users u ON u.id=c.citizen_id WHERE c.id=$1", [result.rows[0].id]);
    return res.status(201).json(complaintRow(joined.rows[0]));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/citizen/complaints/:id", requireRole("citizen"), async (req, res) => {
  try {
    const { id } = GetCitizenComplaintParams.parse(req.params);
    const result = await pool.query(
      `SELECT c.*, citizen.full_name AS citizen_name, collector.full_name AS collector_name
       FROM complaints c JOIN users citizen ON citizen.id=c.citizen_id
       LEFT JOIN users collector ON collector.id=c.assigned_collector_id
       WHERE c.id=$1 AND c.citizen_id=$2`,
      [id, req.user!.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Complaint not found" });
    const history = await pool.query("SELECT new_status AS status, created_at AS timestamp, note FROM complaint_status_history WHERE complaint_id=$1 ORDER BY created_at", [id]);
    return res.json({ ...complaintRow(result.rows[0]), timeline: history.rows.map((row) => ({ ...row, timestamp: iso(row.timestamp) })) });
  } catch (error) {
    return sendError(res, error);
  }
});

async function notifications(req: Request, res: Response) {
  const result = await pool.query("SELECT id, type, title, message, created_at, read_at IS NOT NULL AS read FROM notifications WHERE user_id=$1 ORDER BY created_at DESC", [req.user!.id]);
  return res.json(result.rows.map((row) => ({ id: String(row.id), type: row.type, title: row.title, message: row.message, createdAt: iso(row.created_at), read: row.read })));
}

router.get("/citizen/notifications", requireRole("citizen"), notifications);
router.get("/collector/notifications", requireRole("collector"), notifications);

router.patch("/citizen/notifications/:id/read", requireRole("citizen"), async (req, res) => {
  const { id } = MarkCitizenNotificationReadParams.parse(req.params);
  const result = await pool.query("UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id,type,title,message,created_at,read_at IS NOT NULL AS read", [id, req.user!.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Notification not found" });
  return res.json({ id: String(result.rows[0].id), type: result.rows[0].type, title: result.rows[0].title, message: result.rows[0].message, createdAt: iso(result.rows[0].created_at), read: true });
});

router.get("/collector/dashboard", requireRole("collector"), async (req, res) => {
  const assignments = await pool.query(`${scheduleSelect} WHERE ca.collector_id=$1 AND s.collection_date >= CURRENT_DATE ORDER BY s.collection_date, s.start_time`, [req.user!.id]);
  const counts = await pool.query("SELECT status, COUNT(*)::int AS count FROM collection_assignments WHERE collector_id=$1 GROUP BY status", [req.user!.id]);
  const map = Object.fromEntries(counts.rows.map((row) => [row.status, row.count]));
  return res.json({ today: assignments.rows.filter((row) => String(row.collection_date).slice(0, 10) === new Date().toISOString().slice(0, 10)).length, pending: (map.assigned ?? 0) + (map.accepted ?? 0) + (map.in_progress ?? 0), completed: map.completed ?? 0, missed: map.missed ?? 0, incidents: 0, assignments: assignments.rows.map((row) => ({ ...scheduleRow(row), collectorId: req.user!.id, notes: row.notes ?? null, failureReason: row.failure_reason ?? null })) });
});

router.get("/collector/assignments", requireRole("collector"), async (req, res) => {
  const result = await pool.query(`${scheduleSelect} WHERE ca.collector_id=$1 ORDER BY s.collection_date DESC, s.start_time`, [req.user!.id]);
  return res.json(result.rows.map((row) => ({ ...scheduleRow(row), collectorId: req.user!.id, notes: row.notes ?? null, failureReason: row.failure_reason ?? null })));
});

router.patch("/collector/assignments/:id/status", requireRole("collector"), async (req, res) => {
  try {
    const { id } = UpdateCollectorAssignmentStatusParams.parse(req.params);
    const body = UpdateCollectorAssignmentStatusBody.parse(req.body);
    const result = await pool.query(
      `UPDATE collection_assignments SET status=$1, notes=COALESCE($2, notes), failure_reason=COALESCE($3, failure_reason),
       started_at=CASE WHEN $1='in_progress' THEN COALESCE(started_at,NOW()) ELSE started_at END,
       completed_at=CASE WHEN $1='completed' THEN NOW() ELSE completed_at END
       WHERE id=$4 AND collector_id=$5 RETURNING *`,
      [body.status, body.notes ?? null, body.failureReason ?? null, id, req.user!.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Assignment not found" });
    const joined = await pool.query(`${scheduleSelect} WHERE ca.id=$1`, [id]);
    return res.json({ ...scheduleRow(joined.rows[0]), collectorId: req.user!.id, notes: result.rows[0].notes ?? null, failureReason: result.rows[0].failure_reason ?? null });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/dashboard", requireRole("admin"), async (_req, res) => {
  const [counts, activity] = await Promise.all([
    pool.query(`SELECT
      COUNT(*) FILTER (WHERE role='citizen')::int AS citizens,
      COUNT(*) FILTER (WHERE role='collector' AND status='active')::int AS collectors,
      (SELECT COUNT(*)::int FROM collection_points WHERE active) AS collection_points,
      (SELECT COUNT(*)::int FROM collection_assignments ca JOIN collection_schedules s ON s.id=ca.schedule_id WHERE s.collection_date=CURRENT_DATE) AS today_collections,
      COUNT(*) FILTER (WHERE false)::int AS unused
      FROM users`),
    pool.query(`SELECT 'Complaint updated' AS title, title AS description, updated_at AS timestamp, 'amber' AS tone FROM complaints ORDER BY updated_at DESC LIMIT 5`),
  ]);
  const c = counts.rows[0];
  const metrics = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE status NOT IN ('resolved','rejected'))::int AS open_complaints,
    COUNT(*) FILTER (WHERE severity='critical' AND status NOT IN ('resolved','rejected'))::int AS critical_complaints
    FROM complaints`);
  const collectionStats = await pool.query("SELECT COUNT(*) FILTER (WHERE status='completed')::int AS completed, COUNT(*) FILTER (WHERE status='missed')::int AS missed, COUNT(*)::int AS total FROM collection_assignments");
  const overflow = await pool.query("SELECT COUNT(*)::int AS count FROM overflow_reports WHERE status NOT IN ('resolved','rejected')");
  const stats = collectionStats.rows[0];
  return res.json({
    citizens: c.citizens, collectors: c.collectors, collectionPoints: c.collection_points, todayCollections: c.today_collections,
    completedCollections: stats.completed, missedCollections: stats.missed, openComplaints: metrics.rows[0].open_complaints, criticalComplaints: metrics.rows[0].critical_complaints,
    overflowReports: overflow.rows[0].count, resolutionRate: stats.total ? Math.round((stats.completed / stats.total) * 100) : 0, completionRate: stats.total ? Math.round((stats.completed / stats.total) * 100) : 0,
    activity: activity.rows.map((row) => ({ ...row, timestamp: iso(row.timestamp) })),
  });
});

router.get("/admin/users", requireRole("admin"), async (req, res) => {
  const params = GetAdminUsersQueryParams.parse(req.query);
  const search = params.search ? `%${params.search}%` : null;
  const result = await pool.query("SELECT u.*, z.name AS zone_name FROM users u LEFT JOIN zones z ON z.id=u.zone_id WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1) ORDER BY u.created_at DESC", [search]);
  return res.json(result.rows.map(publicUser));
});

router.patch("/admin/users/:id/status", requireRole("admin"), async (req, res) => {
  try {
    const { id } = UpdateAdminUserStatusParams.parse(req.params);
    const body = UpdateAdminUserStatusBody.parse(req.body);
    const result = await pool.query("UPDATE users SET status=$1 WHERE id=$2 RETURNING *", [body.status, id]);
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    await pool.query("INSERT INTO audit_logs (actor_id,action,entity,metadata) VALUES ($1,'update_status','user',$2)", [req.user!.id, JSON.stringify({ id, status: body.status })]);
    return res.json(publicUser(result.rows[0]));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/zones", requireRole("admin"), async (_req, res) => {
  const result = await pool.query(`SELECT z.*, COUNT(DISTINCT cp.id)::int AS points, COUNT(DISTINCT u.id)::int AS residents
    FROM zones z LEFT JOIN collection_points cp ON cp.zone_id=z.id LEFT JOIN users u ON u.zone_id=z.id AND u.role='citizen' GROUP BY z.id ORDER BY z.name`);
  return res.json(result.rows.map((row) => ({ id: String(row.id), name: row.name, code: row.code, active: row.active, points: row.points, residents: row.residents })));
});

router.post("/admin/zones", requireRole("admin"), async (req, res) => {
  try {
    const body = CreateAdminZoneBody.parse(req.body);
    const result = await pool.query("INSERT INTO zones (name,code,description) VALUES ($1,$2,$3) RETURNING id,name,code,active", [body.name, body.code, body.description ?? null]);
    await pool.query("INSERT INTO audit_logs (actor_id,action,entity,entity_id) VALUES ($1,'create','zone',$2)", [req.user!.id, result.rows[0].id]);
    return res.status(201).json({ ...result.rows[0], points: 0, residents: 0 });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/complaints", requireRole("admin"), async (req, res) => {
  const params = GetAdminComplaintsQueryParams.parse(req.query);
  const search = params.search ? `%${params.search}%` : null;
  const result = await pool.query(`SELECT c.*, citizen.full_name AS citizen_name, collector.full_name AS collector_name
    FROM complaints c JOIN users citizen ON citizen.id=c.citizen_id LEFT JOIN users collector ON collector.id=c.assigned_collector_id
    WHERE ($1::text IS NULL OR c.title ILIKE $1 OR c.location ILIKE $1) ORDER BY c.created_at DESC`, [search]);
  return res.json(result.rows.map(complaintRow));
});

router.patch("/admin/complaints/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = UpdateAdminComplaintParams.parse(req.params);
    const body = UpdateAdminComplaintBody.parse(req.body);
    const existing = await pool.query("SELECT status FROM complaints WHERE id=$1", [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Complaint not found" });
    const result = await pool.query(`UPDATE complaints SET status=COALESCE($1,status), resolution_note=COALESCE($2,resolution_note), assigned_collector_id=COALESCE($3,assigned_collector_id), updated_at=NOW(), resolved_at=CASE WHEN $1='resolved' THEN NOW() ELSE resolved_at END WHERE id=$4 RETURNING *`, [body.status ?? null, body.resolutionNote ?? null, body.assignedCollector ?? null, id]);
    await pool.query("INSERT INTO complaint_status_history (complaint_id,changed_by,old_status,new_status,note) VALUES ($1,$2,$3,$4,$5)", [id, req.user!.id, existing.rows[0].status, result.rows[0].status, body.resolutionNote ?? null]);
    await pool.query("INSERT INTO audit_logs (actor_id,action,entity,entity_id) VALUES ($1,'update','complaint',$2)", [req.user!.id, id]);
    const joined = await pool.query("SELECT c.*, citizen.full_name AS citizen_name, collector.full_name AS collector_name FROM complaints c JOIN users citizen ON citizen.id=c.citizen_id LEFT JOIN users collector ON collector.id=c.assigned_collector_id WHERE c.id=$1", [id]);
    return res.json(complaintRow(joined.rows[0]));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/admin/overflow", requireRole("admin"), async (_req, res) => {
  const result = await pool.query("SELECT * FROM overflow_reports ORDER BY created_at DESC");
  return res.json(result.rows.map((row) => ({ id: String(row.id), location: row.location, severity: row.severity, status: row.status, createdAt: iso(row.created_at), description: row.description, assignedCollector: row.assigned_collector_id })));
});

router.get("/admin/analytics", requireRole("admin"), async (_req, res) => {
  const [collections, complaints, wasteCategories, zones] = await Promise.all([
    pool.query("SELECT status AS label, COUNT(*)::int AS value FROM collection_assignments GROUP BY status ORDER BY status"),
    pool.query("SELECT category AS label, COUNT(*)::int AS value FROM complaints GROUP BY category ORDER BY value DESC"),
    pool.query("SELECT waste_type AS label, COUNT(*)::int AS value FROM collection_schedules GROUP BY waste_type ORDER BY value DESC"),
    pool.query("SELECT z.name AS label, COUNT(c.id)::int AS value FROM zones z LEFT JOIN complaints c ON c.location ILIKE '%' || z.name || '%' GROUP BY z.name ORDER BY value DESC"),
  ]);
  return res.json({ collections: collections.rows, complaints: complaints.rows, wasteCategories: wasteCategories.rows, zones: zones.rows });
});

router.get("/admin/audit-logs", requireRole("admin"), async (_req, res) => {
  const result = await pool.query("SELECT a.id, a.action, a.entity, a.metadata, a.created_at, COALESCE(u.full_name,'System') AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100");
  return res.json(result.rows.map((row) => ({ id: String(row.id), action: row.action, entity: row.entity, timestamp: iso(row.created_at), actor: row.actor, metadata: JSON.stringify(row.metadata) })));
});

function fallbackAdvisory(question: string) {
  const text = question.toLowerCase();
  if (text.includes("battery") || text.includes("chemical")) {
    return { answer: "Treat this as hazardous waste and keep it separate from household bins.", category: "hazardous", recommendedAction: "Store it safely and take it to an authorised hazardous-waste or e-waste collection point.", confidence: 0.93, safetyNote: "Do not puncture, burn, or mix batteries and chemicals with other waste.", localRuleNote: "Collection arrangements vary by municipality; confirm the nearest authorised point." };
  }
  if (text.includes("food") || text.includes("peel") || text.includes("organic")) {
    return { answer: "Food scraps are generally wet organic waste when they are free from packaging.", category: "organic", recommendedAction: "Place them in the wet-waste stream or home compost if available.", confidence: 0.91, safetyNote: null, localRuleNote: "Follow your local collection colour and timing rules." };
  }
  if (text.includes("bottle") || text.includes("paper") || text.includes("cardboard")) {
    return { answer: "Clean, dry packaging is usually recyclable when it is not contaminated.", category: "recyclable", recommendedAction: "Rinse or wipe it, let it dry, and place it with dry recyclables.", confidence: 0.86, safetyNote: null, localRuleNote: "Check local guidance for multi-layer packaging and caps." };
  }
  return { answer: "I cannot identify this item with certainty from the description alone.", category: "other", recommendedAction: "Keep it separate until you can confirm the local disposal route.", confidence: 0.52, safetyNote: "If the item is sharp, leaking, pressurised, or chemical, do not place it in a regular bin.", localRuleNote: "Local municipal rules always take precedence over this advisory." };
}

router.post("/ai/waste-assistant", requireAuth, async (req, res) => {
  try {
    const body = AskWasteAssistantBody.parse(req.body);
    let result = fallbackAdvisory(body.question);
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `Return only valid JSON with keys answer, category, recommendedAction, confidence, safetyNote, localRuleNote. Use only categories organic, recyclable, dry, wet, reject, hazardous, e_waste, sanitary, construction, other. Be conservative and advisory. Question: ${body.question}`,
          config: { responseMimeType: "application/json" },
        });
        const parsed = JSON.parse(response.text ?? "");
        if (typeof parsed.answer === "string" && typeof parsed.recommendedAction === "string" && typeof parsed.confidence === "number") {
          result = { ...result, ...parsed, confidence: Math.max(0, Math.min(1, parsed.confidence)) };
        }
      } catch {
        // The deterministic advisory keeps the safety-critical experience available when Gemini is unavailable.
      }
    }
    await pool.query("INSERT INTO ai_advisories (user_id,question,result) VALUES ($1,$2,$3)", [req.user!.id, body.question, JSON.stringify(result)]);
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/ai/history", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT id, question, result, created_at FROM ai_advisories WHERE user_id=$1 ORDER BY created_at DESC LIMIT 25", [req.user!.id]);
  return res.json(result.rows.map((row) => ({ id: String(row.id), question: row.question, ...row.result, createdAt: iso(row.created_at) })));
});

export default router;