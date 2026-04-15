const express = require('express');
const router = express.Router();
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;
const WA_API = `https://graph.facebook.com/v19.0`;

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (message) console.log('📩 Incoming:', JSON.stringify(message));
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(200);
  }
});

router.get('/test', async (req, res) => {
  try {
    const response = await axios.get(`${WA_API}/${PHONE_NUMBER_ID}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    res.json({ success: true, phone: response.data.display_phone_number, name: response.data.verified_name, status: response.data.code_verification_status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

router.post('/register-number', async (req, res) => {
  try {
    const response = await axios.post(`${WA_API}/${PHONE_NUMBER_ID}/register`, { messaging_product: 'whatsapp', pin: '123456' }, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.post('/sellers', async (req, res) => {
  try {
    const { company_id, name, whatsapp, store_name, platform } = req.body;
    if (!name || !whatsapp) return res.status(400).json({ error: 'Name and WhatsApp required' });
    const { data, error } = await supabase.from('sc_sellers').insert([{ company_id, name, whatsapp, store_name, platform }]).select().single();
    if (error) throw error;
    res.json({ success: true, seller: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sellers', async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from('sc_sellers').select('*').order('created_at', { ascending: false });
    if (company_id) query = query.eq('company_id', company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, sellers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents', async (req, res) => {
  try {
    const { company_id, name, whatsapp, role } = req.body;
    const { data, error } = await supabase.from('sc_agents').insert([{ company_id, name, whatsapp, role }]).select().single();
    if (error) throw error;
    res.json({ success: true, agent: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from('sc_agents').select('*').order('created_at', { ascending: false });
    if (company_id) query = query.eq('company_id', company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, agents: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-group', async (req, res) => {
  try {
    const { seller_id } = req.body;
    const { data: seller, error: sellerErr } = await supabase.from('sc_sellers').select('*').eq('id', seller_id).single();
    if (sellerErr) throw sellerErr;
    const { data: sellerAgents } = await supabase.from('sc_seller_agents').select('agent_id, sc_agents(name, whatsapp)').eq('seller_id', seller_id);
    const participants = [{ phone: seller.whatsapp }];
    if (sellerAgents) sellerAgents.forEach(sa => { if (sa.sc_agents?.whatsapp) participants.push({ phone: sa.sc_agents.whatsapp }); });
    const groupResponse = await axios.post(`${WA_API}/${PHONE_NUMBER_ID}/groups`, { name: `${seller.store_name || seller.name} - eNewcleus`, participants }, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    const group_id = groupResponse.data.id;
    await supabase.from('sc_sellers').update({ wa_group_id: group_id }).eq('id', seller_id);
    res.json({ success: true, group_id, participants: participants.length });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.post('/assign-agent', async (req, res) => {
  try {
    const { seller_id, agent_id } = req.body;
    const { data, error } = await supabase.from('sc_seller_agents').insert([{ seller_id, agent_id }]).select().single();
    if (error) throw error;
    res.json({ success: true, assignment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-message', async (req, res) => {
  try {
    const { seller_id, message } = req.body;
    const { data: seller } = await supabase.from('sc_sellers').select('*').eq('id', seller_id).single();
    if (!seller?.wa_group_id) return res.status(400).json({ error: 'Group not created yet' });
    const msgResponse = await axios.post(`${WA_API}/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: seller.wa_group_id, type: 'text', text: { body: message } }, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    await supabase.from('sc_message_logs').insert([{ seller_id, wa_group_id: seller.wa_group_id, status: 'sent', meta_message_id: msgResponse.data.messages?.[0]?.id }]);
    res.json({ success: true, message_id: msgResponse.data.messages?.[0]?.id });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.post('/broadcast', async (req, res) => {
  try {
    const { company_id, message, platform } = req.body;
    let query = supabase.from('sc_sellers').select('*').eq('status', 'active').not('wa_group_id', 'is', null);
    if (company_id) query = query.eq('company_id', company_id);
    if (platform) query = query.eq('platform', platform);
    const { data: sellers, error } = await query;
    if (error) throw error;
    const { data: broadcast } = await supabase.from('sc_broadcasts').insert([{ company_id, message, msg_type: 'utility', target: platform || 'all', status: 'sending', total_sent: sellers.length }]).select().single();
    let sent = 0, failed = 0;
    for (const seller of sellers) {
      try {
        const msgResponse = await axios.post(`${WA_API}/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: seller.wa_group_id, type: 'text', text: { body: message } }, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
        await supabase.from('sc_message_logs').insert([{ broadcast_id: broadcast.id, seller_id: seller.id, wa_group_id: seller.wa_group_id, status: 'sent', meta_message_id: msgResponse.data.messages?.[0]?.id }]);
        sent++;
      } catch (e) { failed++; }
    }
    await supabase.from('sc_broadcasts').update({ status: 'completed', sent_at: new Date(), total_delivered: sent }).eq('id', broadcast.id);
    res.json({ success: true, broadcast_id: broadcast.id, total: sellers.length, sent, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/broadcasts', async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from('sc_broadcasts').select('*').order('created_at', { ascending: false }).limit(50);
    if (company_id) query = query.eq('company_id', company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, broadcasts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agent-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email aur password required!' });
    const { data: agent, error } = await supabase.from('sc_agents').select('*').eq('email', email.toLowerCase()).single();
    if (error || !agent) return res.status(401).json({ error: 'Email nahi mila!' });
    const valid = await bcrypt.compare(password, agent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Password galat hai!' });
    delete agent.password_hash;
    res.json({ success: true, agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/agent-sellers', async (req, res) => {
  try {
    const { agent_id } = req.query;
    if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
    const { data, error } = await supabase.from('sc_seller_agents').select('seller_id, sc_sellers(*)').eq('agent_id', agent_id);
    if (error) throw error;
    res.json({ success: true, sellers: data.map(d => d.sc_sellers).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/message-logs', async (req, res) => {
  try {
    const { seller_id } = req.query;
    let query = supabase.from('sc_message_logs').select('*, sc_sellers(name, store_name)').order('created_at', { ascending: false }).limit(100);
    if (seller_id) query = query.eq('seller_id', seller_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, logs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-agent-login', async (req, res) => {
  try {
    const { agent_id, email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('sc_agents').update({ email: email.toLowerCase(), password_hash: hash }).eq('id', agent_id).select().single();
    if (error) throw error;
    delete data.password_hash;
    res.json({ success: true, agent: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
