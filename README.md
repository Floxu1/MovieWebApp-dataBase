# MovieJavan Web

نسخه وب برنامه دسکتاپ MovieJavan.

## اجرا

```powershell
cd "C:\Users\Rayaneh Pardaz\AppData\Roaming\MovieJavan\new\webapp"
npm start
```

بعد این آدرس را باز کنید:

```text
http://localhost:4173
```

## نکات فنی

- محتوای فیلم‌ها و سریال‌ها از مسیر داخلی `/app/playstore/` لود می‌شود، نه از iframe مستقیم روی سایت خارجی.
- سرور Node.js مثل برنامه C# از user-agent زیر استفاده می‌کند:

```text
chrome88.0.0-mjagent
```

- API key فقط در `server.js` است و به مرورگر فرستاده نمی‌شود.
- بعد از ورود موفق، مسیر `/app/playstore/user/do_login_windows` به صورت POST به سرور اصلی ارسال می‌شود تا جریان ورود مشابه نسخه C# باشد.
- لینک‌های پخش و دانلود که با `type=vlc` یا `type=idm` هستند در وب به صفحه کپی/باز کردن لینک تبدیل می‌شوند، چون وب نمی‌تواند مستقیم VLC یا IDM ویندوز را مثل برنامه دسکتاپ اجرا کند.

## تنظیمات اختیاری

برای تغییر پورت:

```powershell
$env:PORT=4174; npm start
```

برای تغییر دامنه یا API key بدون ویرایش فایل:

```powershell
$env:MOVIEJAVAN_DOMAIN="https://windowsapps.website"
$env:MOVIEJAVAN_API_KEY="..."
npm start
```
