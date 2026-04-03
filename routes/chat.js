const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── GET /api/chat/rooms ───────────────────────────────────────
router.get('/rooms', authMiddleware, async (req, res) => {
  try {
    const { role, name, marketplaceAccess } = req.user;
    const isAdmin = ['Admin', 'Ops Lead', 'Sub Admin', 'CSI Lead', 'SME', 'Team Lead', 'Senior Executive'].includes(role);

    // 1. Clients (role-based)
    let clientQuery = supabase.from('clients')
      .select('client_code, busy_name, marketplace')
      .eq('status', 'Active').order('busy_name');
    if (!isAdmin) {
      clientQuery = clientQuery.or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`);
    } else if (role === 'Sub Admin' && marketplaceAccess?.length) {
      clientQuery = clientQuery.in('marketplace', marketplaceAccess);
    }

    // 2. Groups where user is member
    const { data: myGroupMemberships } = await supabase.from('chat_group_members')
      .select('group_id').eq('user_name', name);
    const myGroupIds = (myGroupMemberships || []).map(m => m.group_id);

    let groups = [];
    if (myGroupIds.length) {
      const { data: groupData } = await supabase.from('chat_groups')
        .select('group_id, group_name, created_by').in('group_id', myGroupIds).order('group_name');
      groups = groupData || [];
    }

    const [{ data: clients }, { data: readData }] = await Promise.all([
      clientQuery.limit(300),
      supabase.from('chat_read').select('room_id, last_read_at').eq('user_name', name),
    ]);

    const readMap = {};
    (readData || []).forEach(r => { readMap[r.room_id] = r.last_read_at; });

    // Get last messages (recent 500 across all rooms)
    const clientIds = (clients || []).map(c => c.client_code);
    const allRoomIds = ['team-general', ...myGroupIds, ...clientIds];
    const { data: lastMsgs } = await supabase.from('chat_messages')
      .select('room_id, message, file_type, sender_name, created_at')
      .in('room_id', allRoomIds)
      .order('created_at', { ascending: false })
      .limit(500);

    const lastMsgMap = {}, unreadMap = {};
    (lastMsgs || []).forEach(m => {
      if (!lastMsgMap[m.room_id]) lastMsgMap[m.room_id] = m;
      const lastRead = readMap[m.room_id];
      if (m.sender_name !== name && (!lastRead || new Date(m.created_at) > new Date(lastRead))) {
        unreadMap[m.room_id] = (unreadMap[m.room_id] || 0) + 1;
      }
    });

    const makeRoom = (id, name, type, extra = {}) => ({
      roomId: id, roomName: name, roomType: type,
      lastMessage: lastMsgMap[id]?.message || (lastMsgMap[id]?.file_type ? '📎 File' : null),
      lastSender: lastMsgMap[id]?.sender_name || null,
      lastTime: lastMsgMap[id]?.created_at || null,
      unread: unreadMap[id] || 0,
      ...extra,
    });

    const rooms = [
      makeRoom('team-general', '👥 Team General', 'team'),
      ...groups.map(g => makeRoom(g.group_id, g.group_name, 'group', { createdBy: g.created_by })),
      ...(clients || []).map(c => makeRoom(c.client_code, c.busy_name, 'client', { marketplace: c.marketplace })),
    ];

    res.json(rooms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/chat/messages/:roomId ───────────────────────────
router.get('/messages/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    let q = supabase.from('chat_messages').select('*')
      .eq('room_id', roomId).order('created_at', { ascending: false }).limit(limit);
    if (before) q = q.lt('created_at', before);

    const { data, error } = await q;
    if (error) throw error;

    await supabase.from('chat_read').upsert({
      user_name: req.user.name, room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json((data || []).reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/chat/poll/:roomId ───────────────────────────────
router.get('/poll/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const after = req.query.after;
    if (!after) return res.json([]);

    const { data, error } = await supabase.from('chat_messages').select('*')
      .eq('room_id', roomId).gt('created_at', after)
      .order('created_at', { ascending: true }).limit(50);
    if (error) throw error;

    if ((data || []).length > 0) {
      await supabase.from('chat_read').upsert({
        user_name: req.user.name, room_id: roomId,
        last_read_at: new Date().toISOString(),
      }, { onConflict: 'user_name,room_id' });
    }

    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/chat/unread ─────────────────────────────────────
router.get('/unread', authMiddleware, async (req, res) => {
  try {
    const { name } = req.user;
    const { data: readData } = await supabase.from('chat_read')
      .select('room_id, last_read_at').eq('user_name', name);
    const readMap = {};
    (readData || []).forEach(r => { readMap[r.room_id] = r.last_read_at; });

    const { data: msgs } = await supabase.from('chat_messages')
      .select('room_id, sender_name, created_at')
      .neq('sender_name', name).order('created_at', { ascending: false }).limit(200);

    let total = 0;
    (msgs || []).forEach(m => {
      const lastRead = readMap[m.room_id];
      if (!lastRead || new Date(m.created_at) > new Date(lastRead)) total++;
    });

    res.json({ unread: Math.min(total, 99) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/chat/messages ──────────────────────────────────
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const { roomId, roomName, roomType, message } = req.body;
    if (!roomId || !message?.trim()) return res.status(400).json({ error: 'roomId and message required' });

    const msgId = 'MSG' + Date.now().toString();
    const { error } = await supabase.from('chat_messages').insert({
      message_id: msgId, room_type: roomType || 'client',
      room_id: roomId, room_name: roomName || roomId,
      sender_name: req.user.name, sender_role: req.user.role,
      message: message.trim(),
    });
    if (error) throw error;

    await supabase.from('chat_read').upsert({
      user_name: req.user.name, room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json({ success: true, messageId: msgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/chat/upload ────────────────────────────────────
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { roomId, roomName, roomType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!roomId) return res.status(400).json({ error: 'roomId required' });

    const file = req.file;
    const ext = file.originalname.split('.').pop().toLowerCase();
    const fileType = ['jpg','jpeg','png','gif','webp'].includes(ext) ? 'image'
                   : ext === 'pdf' ? 'pdf'
                   : ['xlsx','xls','csv'].includes(ext) ? 'excel' : 'other';

    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${roomId}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('chat-files').upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('chat-files').getPublicUrl(filePath);
    const msgId = 'MSG' + Date.now().toString();

    const { error } = await supabase.from('chat_messages').insert({
      message_id: msgId, room_type: roomType || 'client',
      room_id: roomId, room_name: roomName || roomId,
      sender_name: req.user.name, sender_role: req.user.role,
      message: req.body.message || '',
      file_url: urlData.publicUrl, file_name: file.originalname, file_type: fileType,
    });
    if (error) throw error;

    await supabase.from('chat_read').upsert({
      user_name: req.user.name, room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json({ success: true, messageId: msgId, fileUrl: urlData.publicUrl, fileType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/chat/groups ─── Create group ──────────────────
router.post('/groups', authMiddleware, async (req, res) => {
  try {
    const { groupName, members } = req.body;
    if (!groupName?.trim()) return res.status(400).json({ error: 'Group name required' });
    if (!members?.length) return res.status(400).json({ error: 'At least 1 member required' });

    const groupId = 'GRP' + Date.now().toString();
    const { error } = await supabase.from('chat_groups').insert({
      group_id: groupId, group_name: groupName.trim(), created_by: req.user.name,
    });
    if (error) throw error;

    // Add creator + members
    const allMembers = [...new Set([req.user.name, ...members])];
    const memberRows = allMembers.map(m => ({ group_id: groupId, user_name: m, added_by: req.user.name }));
    await supabase.from('chat_group_members').insert(memberRows);

    res.json({ success: true, groupId, groupName: groupName.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/chat/groups/:groupId/members ───────────────────
router.get('/groups/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('chat_group_members')
      .select('user_name, added_by, added_at').eq('group_id', req.params.groupId);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/chat/groups/:groupId/members ── Add member ────
router.post('/groups/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const { userName } = req.body;
    if (!userName) return res.status(400).json({ error: 'userName required' });
    const { error } = await supabase.from('chat_group_members').upsert({
      group_id: req.params.groupId, user_name: userName, added_by: req.user.name,
    }, { onConflict: 'group_id,user_name' });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/chat/groups/:groupId/members/:userName ──────
router.delete('/groups/:groupId/members/:userName', authMiddleware, async (req, res) => {
  try {
    await supabase.from('chat_group_members')
      .delete().eq('group_id', req.params.groupId).eq('user_name', req.params.userName);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/chat/groups/:groupId ── Delete group ────────
router.delete('/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const allowed = ['Admin', 'Ops Lead'].includes(req.user.role);
    const { data: grp } = await supabase.from('chat_groups').select('created_by').eq('group_id', req.params.groupId).single();
    if (!allowed && grp?.created_by !== req.user.name) return res.status(403).json({ error: 'Not allowed' });

    await supabase.from('chat_group_members').delete().eq('group_id', req.params.groupId);
    await supabase.from('chat_messages').delete().eq('room_id', req.params.groupId);
    await supabase.from('chat_groups').delete().eq('group_id', req.params.groupId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
