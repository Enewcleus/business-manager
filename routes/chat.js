const router = require('express').Router();
const supabase = require('../db');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/chat/rooms — client rooms list + team room
router.get('/rooms', authMiddleware, async (req, res) => {
  try {
    const { role, name, marketplaceAccess } = req.user;
    const isAdmin = ['Admin', 'Ops Lead', 'Sub Admin', 'CSI Lead', 'SME', 'Team Lead', 'Senior Executive'].includes(role);

    let clientQuery = supabase.from('clients').select('client_code, busy_name, marketplace').eq('status', 'Active').order('busy_name');
    if (!isAdmin) {
      clientQuery = clientQuery.or(`am_name.ilike.%${name}%,ads_manager.ilike.%${name}%,crm_executive.ilike.%${name}%`);
    } else if (role === 'Sub Admin' && marketplaceAccess?.length) {
      clientQuery = clientQuery.in('marketplace', marketplaceAccess);
    }

    const { data: clients, error } = await clientQuery.limit(300);
    if (error) throw error;

    // Get unread counts per room for this user
    const { data: readData } = await supabase.from('chat_read')
      .select('room_id, last_read_at').eq('user_name', name);
    const readMap = {};
    (readData || []).forEach(r => { readMap[r.room_id] = r.last_read_at; });

    // Get last message + unread count for each room
    const roomIds = ['team-general', ...(clients || []).map(c => c.client_code)];
    const { data: lastMsgs } = await supabase.from('chat_messages')
      .select('room_id, message, file_type, sender_name, created_at')
      .in('room_id', roomIds)
      .order('created_at', { ascending: false });

    const lastMsgMap = {};
    const unreadMap = {};
    (lastMsgs || []).forEach(m => {
      if (!lastMsgMap[m.room_id]) lastMsgMap[m.room_id] = m;
      const lastRead = readMap[m.room_id];
      if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
        if (m.sender_name !== name) {
          unreadMap[m.room_id] = (unreadMap[m.room_id] || 0) + 1;
        }
      }
    });

    const rooms = [
      {
        roomId: 'team-general',
        roomName: '👥 Team General',
        roomType: 'team',
        lastMessage: lastMsgMap['team-general']?.message || (lastMsgMap['team-general']?.file_type ? '📎 File' : null),
        lastSender: lastMsgMap['team-general']?.sender_name || null,
        lastTime: lastMsgMap['team-general']?.created_at || null,
        unread: unreadMap['team-general'] || 0,
      },
      ...(clients || []).map(c => ({
        roomId: c.client_code,
        roomName: c.busy_name,
        roomType: 'client',
        marketplace: c.marketplace,
        lastMessage: lastMsgMap[c.client_code]?.message || (lastMsgMap[c.client_code]?.file_type ? '📎 File' : null),
        lastSender: lastMsgMap[c.client_code]?.sender_name || null,
        lastTime: lastMsgMap[c.client_code]?.created_at || null,
        unread: unreadMap[c.client_code] || 0,
      })),
    ];

    res.json(rooms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/messages/:roomId — get messages for a room
router.get('/messages/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before; // for pagination

    let q = supabase.from('chat_messages').select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (before) q = q.lt('created_at', before);

    const { data, error } = await q;
    if (error) throw error;

    // Mark as read
    await supabase.from('chat_read').upsert({
      user_name: req.user.name,
      room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json((data || []).reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/poll/:roomId — poll for new messages after a timestamp
router.get('/poll/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const after = req.query.after;
    if (!after) return res.json([]);

    const { data, error } = await supabase.from('chat_messages').select('*')
      .eq('room_id', roomId)
      .gt('created_at', after)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw error;

    if ((data || []).length > 0) {
      await supabase.from('chat_read').upsert({
        user_name: req.user.name,
        room_id: roomId,
        last_read_at: new Date().toISOString(),
      }, { onConflict: 'user_name,room_id' });
    }

    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chat/unread — total unread count for bell
router.get('/unread', authMiddleware, async (req, res) => {
  try {
    const { name } = req.user;
    const { data: readData } = await supabase.from('chat_read').select('room_id, last_read_at').eq('user_name', name);
    const readMap = {};
    (readData || []).forEach(r => { readMap[r.room_id] = r.last_read_at; });

    const { data: msgs } = await supabase.from('chat_messages')
      .select('room_id, sender_name, created_at')
      .neq('sender_name', name)
      .order('created_at', { ascending: false })
      .limit(500);

    let total = 0;
    (msgs || []).forEach(m => {
      const lastRead = readMap[m.room_id];
      if (!lastRead || new Date(m.created_at) > new Date(lastRead)) total++;
    });

    res.json({ unread: Math.min(total, 99) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/messages — send text message
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const { roomId, roomName, roomType, message } = req.body;
    if (!roomId || !message?.trim()) return res.status(400).json({ error: 'roomId and message required' });

    const msgId = 'MSG' + Date.now().toString();
    const { error } = await supabase.from('chat_messages').insert({
      message_id: msgId,
      room_type: roomType || 'client',
      room_id: roomId,
      room_name: roomName || roomId,
      sender_name: req.user.name,
      sender_role: req.user.role,
      message: message.trim(),
    });
    if (error) throw error;

    // Mark as read for sender
    await supabase.from('chat_read').upsert({
      user_name: req.user.name,
      room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json({ success: true, messageId: msgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat/upload — upload file
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { roomId, roomName, roomType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!roomId) return res.status(400).json({ error: 'roomId required' });

    const file = req.file;
    const ext = file.originalname.split('.').pop().toLowerCase();
    const fileType = ['jpg','jpeg','png','gif','webp'].includes(ext) ? 'image'
                   : ['pdf'].includes(ext) ? 'pdf'
                   : ['xlsx','xls','csv'].includes(ext) ? 'excel'
                   : 'other';

    const filePath = `${roomId}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { error: uploadError } = await supabase.storage
      .from('chat-files')
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('chat-files').getPublicUrl(filePath);
    const fileUrl = urlData.publicUrl;

    const msgId = 'MSG' + Date.now().toString();
    const { error } = await supabase.from('chat_messages').insert({
      message_id: msgId,
      room_type: roomType || 'client',
      room_id: roomId,
      room_name: roomName || roomId,
      sender_name: req.user.name,
      sender_role: req.user.role,
      message: req.body.message || '',
      file_url: fileUrl,
      file_name: file.originalname,
      file_type: fileType,
    });
    if (error) throw error;

    await supabase.from('chat_read').upsert({
      user_name: req.user.name,
      room_id: roomId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_name,room_id' });

    res.json({ success: true, messageId: msgId, fileUrl, fileType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
