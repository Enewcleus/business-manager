const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

const SLA_HOURS = { Critical: 4, High: 12, Medium: 24, Low: 48 };

// CSI Lead / Devendra who can approve ticket closure
const APPROVAL_ROLES = ['Admin', 'Ops Lead', 'CSI Lead'];

function assignTicket(category) {
  if (category === 'Ads / Campaign') return { to: 'Ads Executive', role: 'Ads Executive' };
  if (category === 'CSI Review Due') return { to: 'CRM Executive', role: 'CRM Executive' };
  if (['Escalation', 'Seller Complaint'].includes(category)) return { to: 'Ops Lead', role: 'Ops Lead' };
  return { to: 'Account Manager', role: 'Account Manager' };
}

// GET /api/tickets
router.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  const isAdmin = ['Admin', 'Ops Lead', 'CSI Lead', 'Sub Admin', 'Team Lead', 'SME'].includes(role);

  let query = supabase.from('tickets').select('*').order('created_at', { ascending: false });

  if (!isAdmin) {
    const clientQ = await supabase.from('clients').select('client_code')
      .or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`);
    const codes = (clientQ.data || []).map(c => c.client_code);

    if (codes.length) {
      query = query.or(`assigned_to.ilike.%${name}%,raised_by.ilike.%${name}%,client_code.in.(${codes.join(',')})`);
    } else {
      query = query.or(`assigned_to.ilike.%${name}%,raised_by.ilike.%${name}%`);
    }
  }

  const { data, error } = await query.limit(300);
  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  res.json(data.map(t => {
    const created = new Date(t.created_at);
    const slaHours = SLA_HOURS[t.priority] || 24;
    const hoursOpen = Math.round((now - created) / 3600000);

    // Hours to close — use actual or running count
    let hoursToClose = t.hours_to_close || null;
    if (!hoursToClose && t.approved_at) {
      hoursToClose = Math.round((new Date(t.approved_at) - created) / 3600000);
    }

    return {
      ticketId: t.ticket_id,
      clientCode: t.client_code,
      clientName: t.client_name,
      raisedBy: t.raised_by,
      assignedTo: t.assigned_to,
      assignedToRole: t.assigned_to_role,
      category: t.category,
      priority: t.priority,
      description: t.description,
      status: t.status,
      resolutionNote: t.resolution_note,
      slaBreached: t.status !== 'Done' && hoursOpen > slaHours,
      hoursOpen,
      hoursRemaining: Math.max(0, slaHours - hoursOpen),
      hoursToClose,
      createdAt: new Date(t.created_at).toLocaleString('en-IN'),
      resolvedAt: t.resolved_at ? new Date(t.resolved_at).toLocaleString('en-IN') : '',
      resolvedBy: t.resolved_by || '',
      // Approval workflow fields
      closeRequestedAt: t.close_requested_at ? new Date(t.close_requested_at).toLocaleString('en-IN') : '',
      closeRequestedBy: t.close_requested_by || '',
      approvedBy: t.approved_by || '',
      approvedAt: t.approved_at ? new Date(t.approved_at).toLocaleString('en-IN') : '',
    };
  }));
});

// POST /api/tickets
router.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const ticketId = 'TKT' + Date.now().toString().slice(-7);
  const assigned = assignTicket(d.category);

  const { error } = await supabase.from('tickets').insert({
    ticket_id: ticketId,
    client_code: d.clientCode,
    client_name: d.clientName,
    raised_by: req.user.name,
    raised_by_role: req.user.role,
    assigned_to: d.assignedTo || assigned.to,
    assigned_to_role: d.assignedToRole || assigned.role,
    category: d.category,
    priority: d.priority,
    description: d.description,
    status: 'Open',
    sla_hours: SLA_HOURS[d.priority] || 24,
  });
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('notifications').insert({
    notif_id: 'NTF' + Date.now(),
    assigned_to: assigned.to,
    assigned_role: assigned.role,
    type: 'NEW_TICKET',
    message: `New ${d.priority} ticket: ${d.clientName} — ${d.category}`,
    related_id: ticketId,
  }).catch(() => {});

  res.json({ success: true, ticketId, assignedTo: assigned.to });
});

// PATCH /api/tickets/:id — handles 3 actions:
// 1. status change (Open → In Progress)
// 2. request_close — executive requests closure
// 3. approve_close — CSI Lead/Admin approves and marks Done
router.patch('/:id', authMiddleware, async (req, res) => {
  const { status, resolutionNote, action } = req.body;
  const { role, name } = req.user;

  // ── Action: Executive requests closure ──────────────────────
  if (action === 'request_close') {
    if (!resolutionNote?.trim()) return res.status(400).json({ error: 'Resolution note required' });

    const updates = {
      status: 'Pending Approval',
      resolution_note: resolutionNote,
      resolved_by: name,
      resolved_at: new Date(),
      close_requested_at: new Date(),
      close_requested_by: name,
      updated_at: new Date(),
    };

    const { error } = await supabase.from('tickets').update(updates).eq('ticket_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    // Notify CSI Lead / Ops Lead / Admin
    await supabase.from('notifications').insert({
      notif_id: 'NTF' + Date.now(),
      assigned_role: 'CSI Lead',
      type: 'TICKET_APPROVAL',
      message: `Ticket closure approval chahiye: ${req.params.id} — by ${name}`,
      related_id: req.params.id,
    }).catch(() => {});

    // Also notify Admin
    await supabase.from('notifications').insert({
      notif_id: 'NTF' + Date.now() + '1',
      assigned_role: 'Admin',
      type: 'TICKET_APPROVAL',
      message: `Ticket closure approval chahiye: ${req.params.id} — by ${name}`,
      related_id: req.params.id,
    }).catch(() => {});

    return res.json({ success: true, newStatus: 'Pending Approval' });
  }

  // ── Action: CSI Lead / Admin approves closure ────────────────
  if (action === 'approve_close') {
    if (!APPROVAL_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Sirf CSI Lead / Admin approve kar sakte hain' });
    }

    // Get ticket to calculate hours_to_close
    const { data: ticket } = await supabase.from('tickets')
      .select('created_at').eq('ticket_id', req.params.id).single();

    const hoursToClose = ticket?.created_at
      ? Math.round((new Date() - new Date(ticket.created_at)) / 3600000)
      : null;

    const updates = {
      status: 'Done',
      approved_by: name,
      approved_at: new Date(),
      hours_to_close: hoursToClose,
      updated_at: new Date(),
    };

    const { error } = await supabase.from('tickets').update(updates).eq('ticket_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, newStatus: 'Done', hoursToClose });
  }

  // ── Action: Reject close request ─────────────────────────────
  if (action === 'reject_close') {
    if (!APPROVAL_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Sirf CSI Lead / Admin reject kar sakte hain' });
    }

    const updates = {
      status: 'In Progress',
      close_requested_at: null,
      close_requested_by: null,
      updated_at: new Date(),
    };

    const { error } = await supabase.from('tickets').update(updates).eq('ticket_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, newStatus: 'In Progress' });
  }

  // ── Default: Simple status update (Open → In Progress) ───────
  const updates = { status, updated_at: new Date() };
  if (status === 'Done') {
    // Direct done — only for Admin/Ops Lead
    if (!APPROVAL_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Seedha close nahi kar sakte — pehle request_close karo' });
    }
    updates.resolved_at = new Date();
    updates.resolution_note = resolutionNote || '';
    updates.resolved_by = name;
    updates.approved_by = name;
    updates.approved_at = new Date();
    const { data: ticket } = await supabase.from('tickets').select('created_at').eq('ticket_id', req.params.id).single();
    if (ticket?.created_at) {
      updates.hours_to_close = Math.round((new Date() - new Date(ticket.created_at)) / 3600000);
    }
  }

  const { error } = await supabase.from('tickets').update(updates).eq('ticket_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/tickets/stats/time — hours to close stats per executive
router.get('/stats/time', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tickets')
      .select('ticket_id, resolved_by, approved_by, hours_to_close, priority, category, created_at, approved_at, client_name')
      .eq('status', 'Done')
      .not('hours_to_close', 'is', null)
      .order('approved_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    // Group by executive
    const execMap = {};
    (data || []).forEach(t => {
      const exec = t.resolved_by || 'Unknown';
      if (!execMap[exec]) execMap[exec] = { name: exec, tickets: [], totalHours: 0, count: 0 };
      execMap[exec].tickets.push(t);
      execMap[exec].totalHours += t.hours_to_close || 0;
      execMap[exec].count++;
    });

    const result = Object.values(execMap).map(e => ({
      name: e.name,
      totalTickets: e.count,
      avgHoursToClose: e.count ? Math.round(e.totalHours / e.count) : 0,
      minHours: Math.min(...e.tickets.map(t => t.hours_to_close || 0)),
      maxHours: Math.max(...e.tickets.map(t => t.hours_to_close || 0)),
      recentTickets: e.tickets.slice(0, 5).map(t => ({
        ticketId: t.ticket_id,
        clientName: t.client_name,
        hoursToClose: t.hours_to_close,
        priority: t.priority,
        approvedAt: t.approved_at ? new Date(t.approved_at).toLocaleDateString('en-IN') : '—',
      })),
    })).sort((a, b) => a.avgHoursToClose - b.avgHoursToClose);

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
