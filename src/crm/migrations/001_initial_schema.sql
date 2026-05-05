CREATE TABLE IF NOT EXISTS crm_boards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sales',
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , settings_json TEXT DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_boards_tenant ON crm_boards(tenant_id, position);
CREATE TABLE IF NOT EXISTS crm_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#9B59FC',
      auto_rule_json TEXT,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    , wip_limit INTEGER, stage_type TEXT DEFAULT 'open');
CREATE INDEX IF NOT EXISTS idx_columns_board ON crm_columns(board_id, position);
CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      avatar_url TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_interaction_at INTEGER
    , company TEXT, title TEXT, website TEXT, address TEXT, birthdate_ts INTEGER, cpf_cnpj TEXT, lead_score INTEGER DEFAULT 0, deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON crm_contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON crm_contacts(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON crm_contacts(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON crm_contacts(tenant_id, name);
CREATE TABLE IF NOT EXISTS crm_cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES crm_columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      owner_agent_id TEXT,
      value_cents INTEGER NOT NULL DEFAULT 0,
      probability INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL DEFAULT '[]',
      due_date INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER
    , priority INTEGER DEFAULT 3, color TEXT, status TEXT DEFAULT 'active', archived_at INTEGER, swimlane_id TEXT, lost_reason TEXT, won_reason TEXT, deleted_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0, last_inbound_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_cards_tenant ON crm_cards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cards_column ON crm_cards(column_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_contact ON crm_cards(contact_id);
CREATE INDEX IF NOT EXISTS idx_cards_owner ON crm_cards(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_cards_due ON crm_cards(tenant_id, due_date) WHERE due_date IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_activities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'manual',
      direction TEXT,
      content TEXT NOT NULL DEFAULT '',
      media_url TEXT,
      media_type TEXT,
      provider_message_id TEXT,
      created_by_agent_id TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    , thread_id TEXT, read_by_json TEXT DEFAULT '[]', is_private INTEGER DEFAULT 0, labels_json TEXT DEFAULT '[]', snoozed_until INTEGER, priority INTEGER DEFAULT 0, duration_seconds INTEGER, call_outcome TEXT, email_subject TEXT, attachments_json TEXT DEFAULT '[]', mentions_json TEXT DEFAULT '[]', deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_activities_card ON crm_activities(card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON crm_activities(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_tenant ON crm_activities(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_pid ON crm_activities(provider_message_id);
CREATE TABLE IF NOT EXISTS crm_agents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'agent',
      active INTEGER NOT NULL DEFAULT 1,
      api_key_hash TEXT,
      created_at INTEGER NOT NULL, permissions_json TEXT DEFAULT '{}', team_id TEXT, avatar_url TEXT, working_hours_json TEXT DEFAULT '{}', status TEXT DEFAULT 'offline', last_seen_at INTEGER, skills_json TEXT DEFAULT '[]',
      UNIQUE(tenant_id, email)
    );
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON crm_agents(tenant_id, active);
CREATE TABLE IF NOT EXISTS crm_channels (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credentials_encrypted TEXT NOT NULL,
      phone_number TEXT,
      phone_number_id TEXT,
      webhook_secret TEXT,
      last_inbound_at INTEGER,
      created_at INTEGER NOT NULL
    , health_json TEXT DEFAULT '{}', messages_sent INTEGER DEFAULT 0, messages_received INTEGER DEFAULT 0, last_error TEXT, last_health_check INTEGER, auto_create_cards INTEGER DEFAULT 1, inbox_board_id TEXT, inbox_column_id TEXT);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON crm_channels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_channels_phone_id ON crm_channels(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_channels_webhook ON crm_channels(webhook_secret);
CREATE TABLE IF NOT EXISTS crm_subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
      plan_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      cycle TEXT NOT NULL DEFAULT 'monthly',
      next_charge_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      cancelled_at INTEGER
    , trial_until INTEGER, stripe_subscription_id TEXT, stripe_customer_id TEXT, stripe_price_id TEXT, cancel_reason TEXT, cancel_at INTEGER, upgrade_from_id TEXT, payment_link TEXT, last_invoice_id TEXT, coupon_code TEXT, mrr_cents INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON crm_subscriptions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_next_charge ON crm_subscriptions(next_charge_at) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS crm_automations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_json TEXT NOT NULL,
      conditions_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL,
      last_run_at INTEGER,
      runs_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    , schedule_cron TEXT, next_run_at INTEGER, run_count INTEGER DEFAULT 0, webhook_secret TEXT);
CREATE INDEX IF NOT EXISTS idx_automations_tenant ON crm_automations(tenant_id, enabled);
CREATE TABLE IF NOT EXISTS crm_inventory (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, category_id TEXT, barcode TEXT, images_json TEXT DEFAULT '[]', min_stock INTEGER DEFAULT 0, max_stock INTEGER, cost_cents INTEGER DEFAULT 0, price_wholesale_cents INTEGER, brand TEXT, weight_grams INTEGER,
      UNIQUE(tenant_id, sku)
    );
CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON crm_inventory(tenant_id);
CREATE TABLE IF NOT EXISTS crm_reminders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_by_agent_id TEXT,
      created_at INTEGER NOT NULL
    , recurrence_rule TEXT, recurrence_end_ts INTEGER, snooze_until INTEGER, channels_json TEXT DEFAULT '["in_app"]', pre_notify_mins INTEGER, status TEXT DEFAULT 'active');
CREATE INDEX IF NOT EXISTS idx_reminders_due ON crm_reminders(due_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_tenant ON crm_reminders(tenant_id, due_at);
CREATE TABLE IF NOT EXISTS crm_settings (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
CREATE TABLE IF NOT EXISTS crm_card_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
      inventory_id TEXT NOT NULL REFERENCES crm_inventory(id) ON DELETE RESTRICT,
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL,
      stock_committed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    , discount_cents INTEGER DEFAULT 0, discount_percent REAL, tax_cents INTEGER DEFAULT 0, tax_percent REAL, notes TEXT, variant_id TEXT);
CREATE INDEX IF NOT EXISTS idx_card_items_card ON crm_card_items(card_id);
CREATE INDEX IF NOT EXISTS idx_card_items_tenant ON crm_card_items(tenant_id);
CREATE TABLE IF NOT EXISTS crm_segments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        filter_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_segments_tenant ON crm_segments(tenant_id);
CREATE TABLE IF NOT EXISTS crm_swimlanes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#9B59FC',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_swimlanes_board ON crm_swimlanes(board_id, position);
CREATE TABLE IF NOT EXISTS crm_checklists (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_checklists_card ON crm_checklists(card_id);
CREATE TABLE IF NOT EXISTS crm_teams (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#9B59FC',
        description TEXT,
        manager_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_teams_tenant ON crm_teams(tenant_id);
CREATE TABLE IF NOT EXISTS crm_sla_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        team_id TEXT,
        agent_id TEXT,
        name TEXT NOT NULL,
        max_response_mins INTEGER NOT NULL,
        escalate_to_agent_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_sla_tenant ON crm_sla_rules(tenant_id, enabled);
CREATE TABLE IF NOT EXISTS crm_labels (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#9B59FC',
        scope TEXT NOT NULL DEFAULT 'inbox',
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_labels_tenant ON crm_labels(tenant_id);
CREATE TABLE IF NOT EXISTS crm_quick_replies (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        shortcut TEXT,
        category TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_qr_tenant ON crm_quick_replies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_qr_shortcut ON crm_quick_replies(tenant_id, shortcut);
CREATE TABLE IF NOT EXISTS crm_inbox_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        keyword TEXT,
        assign_to_agent_id TEXT,
        assign_to_team_id TEXT,
        label_id TEXT,
        priority INTEGER DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_inbox_rules_tenant ON crm_inbox_rules(tenant_id, enabled);
CREATE TABLE IF NOT EXISTS crm_reminder_history (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        reminder_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 1,
        error TEXT
      );
CREATE INDEX IF NOT EXISTS idx_remhist_reminder ON crm_reminder_history(reminder_id);
CREATE TABLE IF NOT EXISTS crm_inv_categories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_invcat_tenant ON crm_inv_categories(tenant_id);
CREATE TABLE IF NOT EXISTS crm_inv_variants (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL REFERENCES crm_inventory(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        attrs_json TEXT NOT NULL DEFAULT '{}',
        stock INTEGER NOT NULL DEFAULT 0,
        price_cents INTEGER,
        barcode TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_invvar_item ON crm_inv_variants(inventory_id);
CREATE TABLE IF NOT EXISTS crm_inv_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL,
        variant_id TEXT,
        delta INTEGER NOT NULL,
        reason TEXT,
        reference TEXT,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_invmov_item ON crm_inv_movements(inventory_id, created_at);
CREATE TABLE IF NOT EXISTS crm_proposals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        subtotal_cents INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        valid_until_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        terms TEXT,
        signed_at INTEGER,
        signed_by TEXT,
        signed_ip TEXT,
        pdf_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , public_token TEXT, viewed_at INTEGER, viewed_count INTEGER DEFAULT 0, first_viewed_ip TEXT, sent_via TEXT, sent_to TEXT, sent_at INTEGER, auto_convert_on_accept INTEGER DEFAULT 1, deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_prop_tenant ON crm_proposals(tenant_id, card_id);
CREATE TABLE IF NOT EXISTS crm_proposal_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        default_terms TEXT,
        tax_percent REAL,
        discount_percent REAL,
        valid_for_days INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE TABLE IF NOT EXISTS crm_invoices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subscription_id TEXT,
        contact_id TEXT,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        due_at INTEGER,
        paid_at INTEGER,
        pdf_url TEXT,
        stripe_invoice_id TEXT,
        payment_method TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON crm_invoices(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_sub ON crm_invoices(subscription_id);
CREATE TABLE IF NOT EXISTS crm_stripe_connect (
        tenant_id TEXT PRIMARY KEY,
        stripe_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        charges_enabled INTEGER NOT NULL DEFAULT 0,
        payouts_enabled INTEGER NOT NULL DEFAULT 0,
        onboarded_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE TABLE IF NOT EXISTS crm_coupons (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code TEXT NOT NULL,
        discount_percent INTEGER,
        discount_cents INTEGER,
        max_redemptions INTEGER,
        times_redeemed INTEGER NOT NULL DEFAULT 0,
        valid_until INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(tenant_id, code)
      );
CREATE INDEX IF NOT EXISTS idx_coupons_tenant ON crm_coupons(tenant_id, active);
CREATE TABLE IF NOT EXISTS crm_dunning_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        action TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_dunning_sub ON crm_dunning_log(subscription_id, created_at);
CREATE TABLE IF NOT EXISTS crm_automation_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        trigger_payload_json TEXT,
        actions_executed INTEGER DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration_ms INTEGER
      );
CREATE INDEX IF NOT EXISTS idx_autlog ON crm_automation_logs(automation_id, fired_at);
CREATE TABLE IF NOT EXISTS crm_assignment_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '{}',
        assign_to_agent_id TEXT,
        assign_to_team_id TEXT,
        skill_required TEXT,
        sla_minutes INTEGER,
        escalate_to_agent_id TEXT,
        priority INTEGER DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_asrules_tenant ON crm_assignment_rules(tenant_id, enabled, priority);
CREATE TABLE IF NOT EXISTS crm_assignment_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        rule_id TEXT,
        card_id TEXT NOT NULL,
        agent_id TEXT,
        team_id TEXT,
        escalated INTEGER NOT NULL DEFAULT 0,
        sla_deadline_ts INTEGER,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_aslog_card ON crm_assignment_log(card_id, created_at);
CREATE TABLE IF NOT EXISTS crm_channel_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES crm_channels(id) ON DELETE CASCADE,
        template_name TEXT NOT NULL,
        language_code TEXT NOT NULL DEFAULT 'pt_BR',
        category TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        body TEXT,
        synced_at INTEGER
      );
CREATE INDEX IF NOT EXISTS idx_chtmpl_channel ON crm_channel_templates(channel_id);
CREATE TABLE IF NOT EXISTS crm_scheduled_reports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,           -- sales | agents | sources | lost-reasons
        interval TEXT NOT NULL,       -- daily | weekly | monthly
        format TEXT NOT NULL DEFAULT 'pdf',  -- pdf | csv
        email_to TEXT NOT NULL,
        board_id TEXT,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_sched_reports_next ON crm_scheduled_reports(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_sched_reports_tenant ON crm_scheduled_reports(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_token ON crm_proposals(public_token) WHERE public_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_proposal_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ip TEXT,
        ua TEXT
      );
CREATE INDEX IF NOT EXISTS idx_prop_events ON crm_proposal_events(proposal_id, ts);
CREATE TABLE IF NOT EXISTS crm_email_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT NOT NULL,
        variables_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_email_tpl_tenant ON crm_email_templates(tenant_id);
CREATE TABLE IF NOT EXISTS crm_email_campaigns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        segment_id TEXT,
        template_id TEXT,
        subject TEXT NOT NULL,
        body_html TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        stats_queued INTEGER DEFAULT 0,
        stats_sent INTEGER DEFAULT 0,
        stats_opened INTEGER DEFAULT 0,
        stats_clicked INTEGER DEFAULT 0,
        stats_unsubscribed INTEGER DEFAULT 0,
        stats_bounced INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON crm_email_campaigns(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON crm_email_campaigns(scheduled_at) WHERE status = 'scheduled';
CREATE TABLE IF NOT EXISTS crm_campaign_sends (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        contact_id TEXT,
        email TEXT NOT NULL,
        send_token TEXT NOT NULL UNIQUE,
        unsub_token TEXT,
        sent_at INTEGER,
        opened_at INTEGER,
        opened_count INTEGER DEFAULT 0,
        opened_ip TEXT,
        clicked_at INTEGER,
        click_count INTEGER DEFAULT 0,
        last_clicked_url TEXT,
        bounced INTEGER DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_csends_campaign ON crm_campaign_sends(campaign_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_csends_token ON crm_campaign_sends(send_token);
CREATE INDEX IF NOT EXISTS idx_csends_unsub ON crm_campaign_sends(unsub_token);
CREATE TABLE IF NOT EXISTS crm_unsubscribes (
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, email)
      );
CREATE TABLE IF NOT EXISTS crm_email_sequences (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        segment_id TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_sequences_tenant ON crm_email_sequences(tenant_id);
CREATE TABLE IF NOT EXISTS crm_sequence_enrollments (
        id TEXT PRIMARY KEY,
        sequence_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        step_idx INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        finished_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_enr_due ON crm_sequence_enrollments(next_run_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enr_lookup ON crm_sequence_enrollments(sequence_id, contact_id);
CREATE TABLE IF NOT EXISTS crm_forms (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '[]',
        mapping_json TEXT NOT NULL DEFAULT '{}',
        redirect_url TEXT,
        board_id TEXT,
        column_id TEXT,
        default_source TEXT DEFAULT 'form',
        notify_emails_json TEXT DEFAULT '[]',
        total_submissions INTEGER DEFAULT 0,
        last_submission_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_forms_tenant ON crm_forms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forms_key ON crm_forms(public_key);
CREATE TABLE IF NOT EXISTS crm_form_submissions (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        contact_id TEXT,
        card_id TEXT,
        ip TEXT,
        ua TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_submissions_form ON crm_form_submissions(form_id, created_at);
CREATE TABLE IF NOT EXISTS crm_inbound_webhooks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hook_key TEXT NOT NULL UNIQUE,
        secret TEXT,
        mapping_json TEXT NOT NULL DEFAULT '{}',
        board_id TEXT,
        column_id TEXT,
        default_source TEXT DEFAULT 'webhook',
        enabled INTEGER NOT NULL DEFAULT 1,
        total_received INTEGER DEFAULT 0,
        last_received_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_hooks_tenant ON crm_inbound_webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_hooks_key ON crm_inbound_webhooks(hook_key);
CREATE TABLE IF NOT EXISTS crm_tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'med',
        status TEXT NOT NULL DEFAULT 'open',
        due_at INTEGER,
        completed_at INTEGER,
        assigned_to_agent_id TEXT,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
        recurrence_json TEXT,
        parent_task_id TEXT,
        alert_minutes_before INTEGER,
        alert_fired_at INTEGER,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON crm_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON crm_tasks(tenant_id, assigned_to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON crm_tasks(tenant_id, due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tasks_card ON crm_tasks(card_id) WHERE card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON crm_tasks(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_alerts ON crm_tasks(due_at, alert_fired_at) WHERE alert_fired_at IS NULL AND alert_minutes_before IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_meta (
        tenant_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (tenant_id, key)
      );
CREATE TABLE IF NOT EXISTS crm_appointments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        timezone TEXT DEFAULT 'America/Sao_Paulo',
        agent_id TEXT,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        meeting_url TEXT,
        location TEXT,
        reminder_minutes INTEGER DEFAULT 30,
        reminder_fired_at INTEGER,
        ics_uid TEXT NOT NULL,
        external_provider TEXT,
        external_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_appt_tenant_start ON crm_appointments(tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_agent ON crm_appointments(agent_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_contact ON crm_appointments(contact_id);
CREATE INDEX IF NOT EXISTS idx_appt_reminder ON crm_appointments(starts_at, reminder_fired_at) WHERE reminder_fired_at IS NULL AND reminder_minutes IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_scheduling_links (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        agent_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
        buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
        availability_json TEXT NOT NULL DEFAULT '{"weekdays":{}}',
        timezone TEXT DEFAULT 'America/Sao_Paulo',
        advance_notice_hours INTEGER NOT NULL DEFAULT 1,
        max_days_ahead INTEGER NOT NULL DEFAULT 30,
        require_email INTEGER NOT NULL DEFAULT 1,
        require_phone INTEGER NOT NULL DEFAULT 0,
        require_name INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        total_bookings INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_slinks_tenant ON crm_scheduling_links(tenant_id);
CREATE TABLE IF NOT EXISTS crm_calendar_integrations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT,
        provider TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        calendar_id TEXT,
        sync_direction TEXT DEFAULT 'both',
        last_sync_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_calint_tenant ON crm_calendar_integrations(tenant_id);
CREATE TABLE IF NOT EXISTS crm_card_comments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_comment_id TEXT,
        edited_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_cmts_card ON crm_card_comments(card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cmts_tenant ON crm_card_comments(tenant_id);
CREATE TABLE IF NOT EXISTS crm_chat_rooms (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'group',
        card_id TEXT,
        contact_id TEXT,
        members_json TEXT NOT NULL DEFAULT '[]',
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_rooms_tenant ON crm_chat_rooms(tenant_id);
CREATE TABLE IF NOT EXISTS crm_chat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES crm_chat_rooms(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        reply_to_id TEXT,
        edited_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_msgs_room ON crm_chat_messages(room_id, created_at);
CREATE TABLE IF NOT EXISTS crm_chat_reads (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );
CREATE TABLE IF NOT EXISTS crm_contact_notes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_notes_contact ON crm_contact_notes(contact_id, pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_tenant ON crm_contact_notes(tenant_id);
CREATE TABLE IF NOT EXISTS crm_agent_mentions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mentioned_agent_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        card_id TEXT,
        contact_id TEXT,
        snippet TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_mentions_agent ON crm_agent_mentions(tenant_id, mentioned_agent_id, read_at, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_cards USING fts5(
        title, description,
        content='crm_cards', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )
/* crm_fts_cards(title,description) */;
CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_contacts USING fts5(
        name, email, phone, notes,
        content='crm_contacts', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )
/* crm_fts_contacts(name,email,phone,notes) */;
CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_activities USING fts5(
        content,
        content='crm_activities', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )
/* crm_fts_activities(content) */;
CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_notes USING fts5(
        content,
        content='crm_contact_notes', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )
/* crm_fts_notes(content) */;
CREATE TRIGGER IF NOT EXISTS tg_fts_cards_ai AFTER INSERT ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(rowid, title, description) VALUES (new.rowid, new.title, COALESCE(new.description,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_cards_ad AFTER DELETE ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(crm_fts_cards, rowid, title, description) VALUES ('delete', old.rowid, old.title, COALESCE(old.description,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_cards_au AFTER UPDATE ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(crm_fts_cards, rowid, title, description) VALUES ('delete', old.rowid, old.title, COALESCE(old.description,''));
        INSERT INTO crm_fts_cards(rowid, title, description) VALUES (new.rowid, new.title, COALESCE(new.description,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_ai AFTER INSERT ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(rowid, name, email, phone, notes)
        VALUES (new.rowid, new.name, COALESCE(new.email,''), COALESCE(new.phone,''), COALESCE(new.notes,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_ad AFTER DELETE ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(crm_fts_contacts, rowid, name, email, phone, notes)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.email,''), COALESCE(old.phone,''), COALESCE(old.notes,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_au AFTER UPDATE ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(crm_fts_contacts, rowid, name, email, phone, notes)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.email,''), COALESCE(old.phone,''), COALESCE(old.notes,''));
        INSERT INTO crm_fts_contacts(rowid, name, email, phone, notes)
        VALUES (new.rowid, new.name, COALESCE(new.email,''), COALESCE(new.phone,''), COALESCE(new.notes,''));
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_acts_ai AFTER INSERT ON crm_activities BEGIN
        INSERT INTO crm_fts_activities(rowid, content) VALUES (new.rowid, new.content);
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_acts_ad AFTER DELETE ON crm_activities BEGIN
        INSERT INTO crm_fts_activities(crm_fts_activities, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_notes_ai AFTER INSERT ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(rowid, content) VALUES (new.rowid, new.content);
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_notes_ad AFTER DELETE ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(crm_fts_notes, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
CREATE TRIGGER IF NOT EXISTS tg_fts_notes_au AFTER UPDATE ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(crm_fts_notes, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO crm_fts_notes(rowid, content) VALUES (new.rowid, new.content);
      END;
CREATE TABLE IF NOT EXISTS crm_saved_views (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        entity TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}',
        sort_json TEXT,
        shared INTEGER NOT NULL DEFAULT 0,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_views_tenant_entity ON crm_saved_views(tenant_id, entity);
CREATE TABLE IF NOT EXISTS crm_outbound_webhooks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        total_sent INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0,
        last_attempt_at INTEGER,
        last_status INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_ohk_tenant ON crm_outbound_webhooks(tenant_id);
CREATE TABLE IF NOT EXISTS crm_webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES crm_outbound_webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER DEFAULT 0,
        http_status INTEGER,
        response_body TEXT,
        last_tried_at INTEGER,
        next_retry_at INTEGER,
        succeeded_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_whd_retry ON crm_webhook_deliveries(next_retry_at) WHERE succeeded_at IS NULL AND next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whd_hook ON crm_webhook_deliveries(webhook_id, created_at);
CREATE TABLE IF NOT EXISTS crm_external_integrations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        agent_id TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        total_synced INTEGER DEFAULT 0,
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_extint_tenant ON crm_external_integrations(tenant_id);
CREATE TABLE IF NOT EXISTS crm_push_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        ua TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
CREATE INDEX IF NOT EXISTS idx_push_agent ON crm_push_subscriptions(tenant_id, agent_id, enabled);
CREATE TABLE IF NOT EXISTS crm_ai_insights (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        entity TEXT NOT NULL,           -- card | contact | board
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,             -- score | next_step | summary | sentiment | forecast | classification
        score_numeric REAL,
        content_text TEXT,
        content_json TEXT,
        confidence REAL,
        model TEXT,
        computed_at INTEGER NOT NULL,
        stale_at INTEGER,
        UNIQUE (tenant_id, entity, entity_id, kind)
      );
CREATE INDEX IF NOT EXISTS idx_ai_lookup ON crm_ai_insights(tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_stale ON crm_ai_insights(stale_at) WHERE stale_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_document_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'custom',
        body_html TEXT NOT NULL,
        variables_json TEXT DEFAULT '[]',
        default_terms TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_doctpl_tenant ON crm_document_templates(tenant_id, kind);
CREATE TABLE IF NOT EXISTS crm_documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
        template_id TEXT,
        title TEXT NOT NULL,
        body_html TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft',
        public_token TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        parent_document_id TEXT,
        signed_at INTEGER,
        signed_by TEXT,
        signed_ip TEXT,
        signature_image_b64 TEXT,
        file_url TEXT,
        sent_via TEXT,
        sent_to TEXT,
        sent_at INTEGER,
        viewed_at INTEGER,
        viewed_count INTEGER DEFAULT 0,
        created_by_agent_id TEXT,
        ics_uid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON crm_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_docs_contact ON crm_documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_docs_card ON crm_documents(card_id);
CREATE INDEX IF NOT EXISTS idx_docs_token ON crm_documents(public_token);
CREATE TABLE IF NOT EXISTS crm_document_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ip TEXT,
        ua TEXT
      );
CREATE INDEX IF NOT EXISTS idx_docevts ON crm_document_events(document_id, ts);
CREATE TABLE IF NOT EXISTS crm_goals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT,
        team_id TEXT,
        kind TEXT NOT NULL,          -- deals_won | revenue | activities | tasks_completed | calls | meetings
        target INTEGER NOT NULL,
        period TEXT NOT NULL,        -- day | week | month | quarter | year | all_time
        start_date INTEGER NOT NULL,
        end_date INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        title TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_goals_agent ON crm_goals(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_goals_team ON crm_goals(tenant_id, team_id);
CREATE TABLE IF NOT EXISTS crm_badges (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT DEFAULT '🏆',
        criteria_json TEXT NOT NULL DEFAULT '{}',
        auto_award INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_badges_tenant ON crm_badges(tenant_id);
CREATE TABLE IF NOT EXISTS crm_agent_badges (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        badge_id TEXT NOT NULL REFERENCES crm_badges(id) ON DELETE CASCADE,
        earned_at INTEGER NOT NULL,
        evidence_json TEXT,
        UNIQUE (agent_id, badge_id)
      );
CREATE INDEX IF NOT EXISTS idx_abdg_agent ON crm_agent_badges(agent_id, earned_at);
CREATE TABLE IF NOT EXISTS crm_consents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,         -- email | sms | whatsapp | phone | all
        purpose TEXT NOT NULL,         -- marketing | transactional | all
        granted INTEGER NOT NULL DEFAULT 1,
        granted_at INTEGER,
        revoked_at INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        evidence_json TEXT
      );
CREATE INDEX IF NOT EXISTS idx_consents_lookup ON crm_consents(tenant_id, contact_id, channel, purpose, revoked_at);
CREATE TABLE IF NOT EXISTS crm_data_access_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_agent_id TEXT,
        action TEXT NOT NULL,           -- view | export | modify | delete
        target_entity TEXT NOT NULL,    -- contact | card | activity | ...
        target_id TEXT NOT NULL,
        accessed_fields_json TEXT,
        ip TEXT,
        ua TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_acl_tenant ON crm_data_access_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_acl_target ON crm_data_access_log(target_entity, target_id);
CREATE TABLE IF NOT EXISTS crm_retention_policies (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        entity TEXT NOT NULL,           -- activities | consents | deletion_requests | data_access_log | contacts_inactive
        days_to_keep INTEGER NOT NULL,
        auto_anonymize INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_retp_tenant ON crm_retention_policies(tenant_id, enabled);
CREATE TABLE IF NOT EXISTS crm_deletion_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        requested_by_email TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        scheduled_for INTEGER NOT NULL,
        completed_at INTEGER,
        mode TEXT NOT NULL DEFAULT 'anonymize',
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_delreq_tenant ON crm_deletion_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_delreq_due ON crm_deletion_requests(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cards_hot ON crm_cards(tenant_id, column_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cards_owner_hot ON crm_cards(tenant_id, owner_agent_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_hot ON crm_contacts(tenant_id, source, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_hot ON crm_activities(tenant_id, contact_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activities_card_hot ON crm_activities(tenant_id, card_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_agent_hot ON crm_tasks(tenant_id, assigned_to_agent_id, status, due_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appts_hot ON crm_appointments(tenant_id, agent_id, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_docs_hot ON crm_documents(tenant_id, contact_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cards_pagination ON crm_cards(tenant_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_pagination ON crm_contacts(tenant_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE VIEW IF NOT EXISTS crm_migration_history AS
      SELECT version, applied_at, datetime(applied_at / 1000, 'unixepoch') AS applied_at_iso
      FROM crm_migrations ORDER BY version
/* crm_migration_history(version,applied_at,applied_at_iso) */;
CREATE TABLE IF NOT EXISTS crm_rate_limit_buckets (
        tenant_id TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, window_start)
      );
CREATE INDEX IF NOT EXISTS idx_rl_prune ON crm_rate_limit_buckets(window_start);
CREATE TABLE IF NOT EXISTS crm_api_tiers (
        tenant_id TEXT PRIMARY KEY,
        tier_name TEXT NOT NULL DEFAULT 'free',
        max_req_per_min INTEGER,
        max_req_per_hour INTEGER,
        updated_at INTEGER NOT NULL
      );
CREATE TABLE IF NOT EXISTS crm_agent_roles (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE (tenant_id, name)
      );
CREATE INDEX IF NOT EXISTS idx_roles_tenant ON crm_agent_roles(tenant_id);
CREATE TABLE IF NOT EXISTS crm_agent_role_assignments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role_id TEXT NOT NULL REFERENCES crm_agent_roles(id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL,
        UNIQUE (agent_id, role_id)
      );
CREATE INDEX IF NOT EXISTS idx_asgn_agent ON crm_agent_role_assignments(agent_id);
CREATE TABLE IF NOT EXISTS crm_2fa (
        agent_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        secret_b32 TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        backup_codes_json TEXT DEFAULT '[]',
        enabled_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      );
CREATE TABLE IF NOT EXISTS crm_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        ip TEXT,
        ua TEXT,
        device_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON crm_sessions(agent_id, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS crm_ip_whitelist (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        cidr TEXT NOT NULL,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_ipwl_tenant ON crm_ip_whitelist(tenant_id, enabled);
CREATE TABLE IF NOT EXISTS crm_audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_agent_id TEXT,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        before_json TEXT,
        after_json TEXT,
        ip TEXT,
        ua TEXT,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON crm_audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON crm_audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON crm_audit_log(actor_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_unread ON crm_cards(tenant_id, unread_count) WHERE unread_count > 0;
