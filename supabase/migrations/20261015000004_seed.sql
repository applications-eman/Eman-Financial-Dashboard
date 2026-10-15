-- Default categories
insert into public.categories (section, name, name_ar) values
  ('bakery','Flour & Grains','دقيق وحبوب'),
  ('bakery','Sugar & Sweeteners','سكر ومحليات'),
  ('bakery','Dairy & Eggs','ألبان وبيض'),
  ('bakery','Packaging','تغليف'),
  ('bakery','Fuel & Gas','وقود وغاز'),
  ('bakery','Equipment & Maintenance','معدات وصيانة'),
  ('bakery','Utilities','مرافق'),
  ('bakery','Other','أخرى'),
  ('grocery','Fresh Produce','خضار وفواكه'),
  ('grocery','Meat & Poultry','لحوم ودواجن'),
  ('grocery','Beverages','مشروبات'),
  ('grocery','Dry Goods','مواد جافة'),
  ('grocery','Cleaning Supplies','مواد تنظيف'),
  ('grocery','Packaging','تغليف'),
  ('grocery','Other','أخرى')
on conflict (section, name) do nothing;

-- Default settings (all editable from the dashboard)
insert into public.app_settings (key, value) values
  ('company_name', '"مخابز إيمان جدة للخبز"'),
  ('company_name_en', '"Eman Bakery Jeddah"'),
  ('vat_rate', '0.15'),
  ('currency', '"SAR"'),
  ('timezone', '"Asia/Riyadh"'),
  ('alert_thresholds', '{"max_invoice_amount": 20000, "vat_tolerance_pct": 0.5, "notify_on_duplicate": true, "notify_on_vat_warning": true}'),
  ('report_schedule', '{"daily_enabled": true, "daily_hour": 21, "weekly_enabled": true, "weekly_day": "sat", "weekly_hour": 9}'),
  ('wa_flow_id', '""'),
  ('wa_trigger_words', '["مصروف","فاتورة","expense","invoice","hi","hello","مرحبا"]'),
  ('message_templates', '{
    "welcome":   {"en": "Welcome {{name}}. Tap the button to record an invoice.", "ar": "أهلاً {{name}}. اضغط الزر لتسجيل فاتورة."},
    "saved":     {"en": "Saved ✅\nSection: {{section}}\nSeller: {{seller}}\nTotal: {{total}} SAR\nVAT: {{vat}} SAR", "ar": "تم الحفظ ✅\nالقسم: {{section}}\nالمورد: {{seller}}\nالإجمالي: {{total}} ر.س\nالضريبة: {{vat}} ر.س"},
    "duplicate": {"en": "Duplicate ⚠️ This invoice was already recorded.", "ar": "مكررة ⚠️ هذه الفاتورة مسجلة مسبقاً."},
    "invalid":   {"en": "Could not read the invoice: {{reason}}", "ar": "تعذرت قراءة الفاتورة: {{reason}}"},
    "not_allowed": {"en": "This number is not registered. Please contact the administrator.", "ar": "هذا الرقم غير مسجل. يرجى التواصل مع المسؤول."},
    "admin_duplicate": {"en": "⚠️ Duplicate attempt by {{name}} in {{section}}: {{seller}} {{total}} SAR", "ar": "⚠️ محاولة تكرار من {{name}} في {{section}}: {{seller}} {{total}} ر.س"},
    "admin_vat_warning": {"en": "⚠️ VAT looks off ({{section}}): {{seller}} total {{total}}, VAT {{vat}}", "ar": "⚠️ الضريبة غير متوافقة ({{section}}): {{seller}} الإجمالي {{total}} الضريبة {{vat}}"}
  }')
on conflict (key) do nothing;

insert into public.feature_flags (key, enabled, description) values
  ('whatsapp_flow', true, 'Allow capture through the WhatsApp Flow'),
  ('whatsapp_text', true, 'Allow capture through plain WhatsApp text / Base64'),
  ('ios_shortcut', true, 'Allow capture through the iOS Shortcut endpoint'),
  ('confirm_to_submitter', true, 'Send a WhatsApp confirmation to the submitter'),
  ('alert_admins', true, 'Alert admins on duplicates and VAT warnings'),
  ('daily_summary', true, 'Send the daily summary per section'),
  ('weekly_report', true, 'Send the weekly report'),
  ('store_invoice_images', true, 'Store uploaded invoice photos in Storage')
on conflict (key) do nothing;

-- Bootstrap the first admin AFTER creating the Auth user (Dashboard > Authentication > Users):
--   select public.bootstrap_admin('admin@example.com', 'Admin Name', '+9665XXXXXXXX');
create or replace function public.bootstrap_admin(p_email text, p_name text, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid; rid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No auth user with email %. Create it in Supabase Auth first.', p_email; end if;
  insert into public.app_users (auth_user_id, name, phone_e164, role, sections, active)
  values (uid, p_name, p_phone, 'admin', array['bakery','grocery'], true)
  on conflict (auth_user_id) do update set role = 'admin', active = true, name = excluded.name
  returning id into rid;
  return rid;
end $$;
revoke all on function public.bootstrap_admin(text, text, text) from public, anon, authenticated;
