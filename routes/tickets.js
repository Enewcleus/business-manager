const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');

const SLA_HOURS = { Critical: 4, High: 12, Medium: 24, Low: 48 };

function assignTicket(category, raisedByRole) {
  if (category === 'Ads / Campaign') return { to: 'Ads Executive', role: 'Ads Executive' };
  if (category === 'CSI Review Due') return { to: 'CRM Executive', role: 'CRM Executive' };
  if (['Escalation', 'Seller Complaint'].includes(category)) return { to: 'Ops Lead', role: 'Ops Lead' };
  return { to: 'Account Manager', role: 'Account Manager' };
}

// GET /api/tickets
router.get('/', authMiddleware, async (req, res) => {
  const { role, name } = req.user;
  let query = supabase.from('tickets').select('*').order('created_at', { ascending: false });

  if (!['Admin', 'Ops Lead', 'CSI Lead'].includes(role)) {
    query = query.or(`raised_by.eq.${name},assigned_to.eq.${name},assigned_to_role.eq.${role}`);
  }

  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  res.json(data.map(t => {
    const created = new Date(t.created_at);
    const slaHours = SLA_HOURS[t.priority] || 24;
    const hoursOpen = Math.round((now - created) / 3600000);
    const hoursRemaining = Math.max(0, slaHours - hoursOpen);
    return {
      ticketId: t.ticket_id, clientCode: t.client_code, clientName: t.client_name,
      raisedBy: t.raised_by, assignedTo: t.assigned_to, assignedToRole: t.assigned_to_role,
      category: t.category, priority: t.priority, description: t.description,
      status: t.status, resolutionNote: t.resolution_note,
      slaBreached: t.status !== 'Done' && hoursOpen > slaHours,
      hoursOpen, hoursRemaining,
      createdAt: new Date(t.created_at).toLocaleString('en-IN'),
      resolvedAt: t.resolved_at ? new Date(t.resolved_at).toLocaleString('en-IN') : '',
    };
  }));
});

// POST /api/tickets
router.post('/', authMiddleware, async (req, res) => {
  const d = req.body;
  const ticketId = 'TKT' + Date.now().toString().slice(-7);
  const assigned = assignTicket(d.category, req.user.role);

  const { error } = await supabase.from('tickets').insert({
    ticket_id: ticketId, client_code: d.clientCode, client_name: d.clientName,
    raised_by: req.user.name, raised_by_role: req.user.role,
    assigned_to: assigned.to, assigned_to_role: assigned.role,
    category: d.category, priority: d.priority, description: d.description,
    status: 'Open', sla_hours: SLA_HOURS[d.priority] || 24,
  });
  if (error) return res.status(500).json({ error: error.message });

  // Notify assigned
  await supabase.from('notifications').insert({
    notif_id: 'NTF' + Date.now(),
    assigned_to: assigned.to, assigned_role: assigned.role,
    type: 'NEW_TICKET', message: `New ${d.priority} ticket: ${d.clientName} — ${d.category}`,
    related_id: ticketId,
  });

  res.json({ success: true, ticketId, assignedTo: assigned.to });
});

// PATCH /api/tickets/:id
router.patch('/:id', authMiddleware, async (req, res) => {
  const { status, resolutionNote } = req.body;
  const updates = { status, updated_at: new Date() };
  if (status === 'Done') { updates.resolved_at = new Date(); updates.resolution_note = resolutionNote || ''; }

  const { error } = await supabase.from('tickets').update(updates).eq('ticket_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
