# RX WA — وسيلة

منصة واتساب أوتوميشن متعددة العملاء (multi-tenant)، مبنية على **Meta Cloud API الرسمي** (صفر خطر حظر)، ذاتية الملك، بدون اشتراك SaaS.

## الميزات
- ✅ ردود تلقائية بدون LLM (محرك Q&A: كلمات مفتاحية + fuzzy match بـ fuse.js).
- ✅ تدفق تلف متعدد الخطوات (رقم طلب ← صورة ← تأكيد).
- ✅ عداد فشل → تحويل للموظف بعد 3 محاولات.
- ✅ لوحة تحكم محمية بكلمة سر (إضافة عملاء + أسئلة + صندوق وارد).
- ✅ تخزين محلي `data/store.json` (يُزرع من `qa.json` تلقائياً عند كل إقلاع — دائم).
- ✅ متعدد العملاء: كل عميل `phoneId` + `token` + `flow` منفصل.

## التشغيل محلياً
```bash
npm install
cp .env.example .env   # عدّل القيم
node server.js
# افتح http://localhost:3000/admin  (admin / RxWa@2026!Admin)
```

## النشر على Render (24/7)
1. ارفع هذا المجلد لـ GitHub.
2. في Render: New → Blueprint → اختر الريبو (يقرأ `render.yaml`).
3. أضف `HALAT_WA_TOKEN` (و `META_APP_SECRET` اختياري) من Environment.
4. بعد النشر: في Meta → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<app>.onrender.com/webhook`
   - Verify token: `RxWa@2026!SecureVerify`
   - اضغط Verify ثم اشترك في `messages`.

## ملفات المشروع
```
server.js      ← البوت كامل
qa.json        ← 47 سؤال/جواب (يُزرع تلقائياً)
package.json
Dockerfile
render.yaml
```

## ملاحظة
التدفق والتخزين محليون (بدون Supabase/Postgres). لاحقاً: يمكن إضافة LLM كمرحلة ثانية.
