const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;
const WA_API = `https://graph.facebook.com/v19.0`;

// ── WEBHOOK VERIFY (Meta requires this) ──────────────────────
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp Webhook verified!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── WEBHOOK RECEIVE (incoming messages) ──────────────────────
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (message) {
        console.log('📩 Incoming WA message:', JSON.stringify(message));
        // TODO: handle replies - log to sc_message_logs
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

// ── TEST API CONNECTION ───────────────────────────────────────
router.get('/test', async (req, res) => {
  try {
    const response = await axios.get(
      `${WA_API}/${PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    res.json({ 
      success: true, 
      phone: response.data.display_phone_number,
      name: response.data.verified_name,
      status: response.data.code_verification_status
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.response?.data || err.message 
    });
  }
});

// ── ADD SELLER ────────────────────────────────────────────────
router.post('/sellers', async (req, res) => {
  try {
    const { company_id, name, whatsapp, store_name, platform } = req.body;
    if (!name || !whatsapp) {
      return res.status(400).json({ error: 'Name and WhatsApp required' });
    }
    const { data, error } = await supabase
      .from('sc_sellers')
      .insert([{ company_id, name, whatsapp, store_name, platform }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, seller: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL SELLERS ───────────────────────────────────────────
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

// ── ADD AGENT ─────────────────────────────────────────────────
router.post('/agents', async (req, res) => {
  try {
    const { company_id, name, whatsapp, role } = req.body;
    const { data, error } = await supabase
      .from('sc_agents')
      .insert([{ company_id, name, whatsapp, role }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, agent: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL AGENTS ────────────────────────────────────────────
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

// ── CREATE WHATSAPP GROUP FOR SELLER ─────────────────────────
router.post('/create-group', async (req, res) => {
  try {
    const { seller_id } = req.body;

    // Get seller details
    const { data: seller, error: sellerErr } = await supabase
      .from('sc_sellers')
      .select('*, sc_seller_agents(agent_id, sc_agents(name, whatsapp))')
      .eq('id', seller_id)
      .single();
    if (sellerErr) throw sellerErr;

    // Get agents for this seller
    const { data: sellerAgents } = await supabase
      .from('sc_seller_agents')
      .select('agent_id, sc_agents(name, whatsapp)')
      .eq('seller_id', seller_id);

    // Build participants list
    const participants = [
      { phone: seller.whatsapp }
    ];
    if (sellerAgents) {
      sellerAgents.forEach(sa => {
        if (sa.sc_agents?.whatsapp) {
          participants.push({ phone: sa.sc_agents.whatsapp });
        }
      });
    }

    // Create group via WhatsApp API
    const groupResponse = await axios.post(
      `${WA_API}/${PHONE_NUMBER_ID}/groups`,
      {
        name: `${seller.store_name || seller.name} - eNewcleus`,
        participants: participants
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );

    const group_id = groupResponse.data.id;

    // Save group ID to seller record
    await supabase
      .from('sc_sellers')
      .update({ wa_group_id: group_id })
      .eq('id', seller_id);

    res.json({ 
      success: true, 
      group_id,
      group_name: `${seller.store_name || seller.name} - eNewcleus`,
      participants: participants.length
    });

  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── ASSIGN AGENT TO SELLER ────────────────────────────────────
router.post('/assign-agent', async (req, res) => {
  try {
    const { seller_id, agent_id } = req.body;
    const { data, error } = await supabase
      .from('sc_seller_agents')
      .insert([{ seller_id, agent_id }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, assignment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND MESSAGE TO ONE SELLER GROUP ─────────────────────────
router.post('/send-message', async (req, res) => {
  try {
    const { seller_id, message } = req.body;

    const { data: seller } = await supabase
      .from('sc_sellers')
      .select('*')
      .eq('id', seller_id)
      .single();

    if (!seller?.wa_group_id) {
      return res.status(400).json({ error: 'Group not created yet for this seller' });
    }

    const msgResponse = await axios.post(
      `${WA_API}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: seller.wa_group_id,
        type: 'text',
        text: { body: message }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );

    // Log it
    await supabase.from('sc_message_logs').insert([{
      seller_id,
      wa_group_id: seller.wa_group_id,
      status: 'sent',
      meta_message_id: msgResponse.data.messages?.[0]?.id
    }]);

    res.json({ success: true, message_id: msgResponse.data.messages?.[0]?.id });

  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── BULK BROADCAST ────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { company_id, message, platform, segment } = req.body;

    // Get sellers with filters
    let query = supabase
      .from('sc_sellers')
      .select('*')
      .eq('status', 'active')
      .not('wa_group_id', 'is', null);

    if (company_id) query = query.eq('company_id', company_id);
    if (platform) query = query.eq('platform', platform);

    const { data: sellers, error } = await query;
    if (error) throw error;

    // Create broadcast record
    const { data: broadcast } = await supabase
      .from('sc_broadcasts')
      .insert([{
        company_id,
        message,
        msg_type: 'utility',
        target: platform || 'all',
        status: 'sending',
        total_sent: sellers.length
      }])
      .select()
      .single();

    // Send to all groups
    let sent = 0;
    let failed = 0;

    for (const seller of sellers) {
      try {
        const msgResponse = await axios.post(
          `${WA_API}/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: seller.wa_group_id,
            type: 'text',
            text: { body: message }
          },
          { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
        );

        await supabase.from('sc_message_logs').insert([{
          broadcast_id: broadcast.id,
          seller_id: seller.id,
          wa_group_id: seller.wa_group_id,
          status: 'sent',
          meta_message_id: msgResponse.data.messages?.[0]?.id
        }]);

        sent++;
      } catch (msgErr) {
        console.error(`Failed for seller ${seller.id}:`, msgErr.message);
        failed++;
      }
    }

    // Update broadcast status
    await supabase
      .from('sc_broadcasts')
      .update({ status: 'completed', sent_at: new Date(), total_delivered: sent })
      .eq('id', broadcast.id);

    res.json({ 
      success: true, 
      broadcast_id: broadcast.id,
      total: sellers.length,
      sent,
      failed
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET BROADCAST HISTORY ─────────────────────────────────────
router.get('/broadcasts', async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase
      .from('sc_broadcasts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (company_id) query = query.eq('company_id', company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, broadcasts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;
const WA_API = `https://graph.facebook.com/v19.0`;

// ── WEBHOOK VERIFY (Meta requires this) ──────────────────────
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp Webhook verified!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── WEBHOOK RECEIVE (incoming messages) ──────────────────────
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (message) {
        console.log('📩 Incoming WA message:', JSON.stringify(message));
        // TODO: handle replies - log to sc_message_logs
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

// ── TEST API CONNECTION ───────────────────────────────────────
router.get('/test', async (req, res) => {
  try {
    const response = await axios.get(
      `${WA_API}/${PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    res.json({ 
      success: true, 
      phone: response.data.display_phone_number,
      name: response.data.verified_name,
      status: response.data.code_verification_status
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.response?.data || err.message 
    });
  }
});

// ── ADD SELLER ────────────────────────────────────────────────
router.post('/sellers', async (req, res) => {
  try {
    const { company_id, name, whatsapp, store_name, platform } = req.body;
    if (!name || !whatsapp) {
      return res.status(400).json({ error: 'Name and WhatsApp required' });
    }
    const { data, error } = await supabase
      .from('sc_sellers')
      .insert([{ company_id, name, whatsapp, store_name, platform }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, seller: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL SELLERS ───────────────────────────────────────────
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

// ── ADD AGENT ─────────────────────────────────────────────────
router.post('/agents', async (req, res) => {
  try {
    const { company_id, name, whatsapp, role } = req.body;
    const { data, error } = await supabase
      .from('sc_agents')
      .insert([{ company_id, name, whatsapp, role }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, agent: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL AGENTS ────────────────────────────────────────────
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

// ── CREATE WHATSAPP GROUP FOR SELLER ─────────────────────────
router.post('/create-group', async (req, res) => {
  try {
    const { seller_id } = req.body;

    // Get seller details
    const { data: seller, error: sellerErr } = await supabase
      .from('sc_sellers')
      .select('*, sc_seller_agents(agent_id, sc_agents(name, whatsapp))')
      .eq('id', seller_id)
      .single();
    if (sellerErr) throw sellerErr;

    // Get agents for this seller
    const { data: sellerAgents } = await supabase
      .from('sc_seller_agents')
      .select('agent_id, sc_agents(name, whatsapp)')
      .eq('seller_id', seller_id);

    // Build participants list
    const participants = [
      { phone: seller.whatsapp }
    ];
    if (sellerAgents) {
      sellerAgents.forEach(sa => {
        if (sa.sc_agents?.whatsapp) {
          participants.push({ phone: sa.sc_agents.whatsapp });
        }
      });
    }

    // Create group via WhatsApp API
    const groupResponse = await axios.post(
      `${WA_API}/${PHONE_NUMBER_ID}/groups`,
      {
        name: `${seller.store_name || seller.name} - eNewcleus`,
        participants: participants
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );

    const group_id = groupResponse.data.id;

    // Save group ID to seller record
    await supabase
      .from('sc_sellers')
      .update({ wa_group_id: group_id })
      .eq('id', seller_id);

    res.json({ 
      success: true, 
      group_id,
      group_name: `${seller.store_name || seller.name} - eNewcleus`,
      participants: participants.length
    });

  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── ASSIGN AGENT TO SELLER ────────────────────────────────────
router.post('/assign-agent', async (req, res) => {
  try {
    const { seller_id, agent_id } = req.body;
    const { data, error } = await supabase
      .from('sc_seller_agents')
      .insert([{ seller_id, agent_id }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, assignment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND MESSAGE TO ONE SELLER GROUP ─────────────────────────
router.post('/send-message', async (req, res) => {
  try {
    const { seller_id, message } = req.body;

    const { data: seller } = await supabase
      .from('sc_sellers')
      .select('*')
      .eq('id', seller_id)
      .single();

    if (!seller?.wa_group_id) {
      return res.status(400).json({ error: 'Group not created yet for this seller' });
    }

    const msgResponse = await axios.post(
      `${WA_API}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: seller.wa_group_id,
        type: 'text',
        text: { body: message }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );

    // Log it
    await supabase.from('sc_message_logs').insert([{
      seller_id,
      wa_group_id: seller.wa_group_id,
      status: 'sent',
      meta_message_id: msgResponse.data.messages?.[0]?.id
    }]);

    res.json({ success: true, message_id: msgResponse.data.messages?.[0]?.id });

  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── BULK BROADCAST ────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { company_id, message, platform, segment } = req.body;

    // Get sellers with filters
    let query = supabase
      .from('sc_sellers')
      .select('*')
      .eq('status', 'active')
      .not('wa_group_id', 'is', null);

    if (company_id) query = query.eq('company_id', company_id);
    if (platform) query = query.eq('platform', platform);

    const { data: sellers, error } = await query;
    if (error) throw error;

    // Create broadcast record
    const { data: broadcast } = await supabase
      .from('sc_broadcasts')
      .insert([{
        company_id,
        message,
        msg_type: 'utility',
        target: platform || 'all',
        status: 'sending',
        total_sent: sellers.length
      }])
      .select()
      .single();

    // Send to all groups
    let sent = 0;
    let failed = 0;

    for (const seller of sellers) {
      try {
        const msgResponse = await axios.post(
          `${WA_API}/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: seller.wa_group_id,
            type: 'text',
            text: { body: message }
          },
          { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
        );

        await supabase.from('sc_message_logs').insert([{
          broadcast_id: broadcast.id,
          seller_id: seller.id,
          wa_group_id: seller.wa_group_id,
          status: 'sent',
          meta_message_id: msgResponse.data.messages?.[0]?.id
        }]);

        sent++;
      } catch (msgErr) {
        console.error(`Failed for seller ${seller.id}:`, msgErr.message);
        failed++;
      }
    }

    // Update broadcast status
    await supabase
      .from('sc_broadcasts')
      .update({ status: 'completed', sent_at: new Date(), total_delivered: sent })
      .eq('id', broadcast.id);

    res.json({ 
      success: true, 
      broadcast_id: broadcast.id,
      total: sellers.length,
      sent,
      failed
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET BROADCAST HISTORY ─────────────────────────────────────
router.get('/broadcasts', async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase
      .from('sc_broadcasts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (company_id) query = query.eq('company_id', company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, broadcasts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── REGISTER PHONE NUMBER ─────────────────────────────────────
router.post('/register-number', async (req, res) => {
  try {
    const response = await axios.post(
      `${WA_API}/${PHONE_NUMBER_ID}/register`,
      {
        messaging_product: 'whatsapp',
        pin: '123456'
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});
module.exports = router;


module.exports = router;
