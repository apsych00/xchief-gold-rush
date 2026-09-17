# BoxAPI — Instagram Data API Reference

Base URL: `https://boxapi.ir/api/instagram/`
همهٔ اندپوینت‌ها (به‌جز `GET /api/my`) با متد **POST** و بدنهٔ **JSON** فراخوانی می‌شوند.

## Auth (مشترک برای همهٔ اندپوینت‌ها)

```
Authorization: Bearer YOUR_API_TOKEN
Content-Type: application/json
```

## الگوی فراخوانی عمومی

```bash
curl --request POST \
  --url https://boxapi.ir/api/instagram/{category}/{action} \
  --header "Authorization: Bearer YOUR_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{ ...params }'
```

فقط `{category}/{action}` و `params` بین اندپوینت‌ها فرق دارد؛ هدرها و متد ثابت است.

---

## User — عملیات مربوط به کاربر

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `user/get_info_by_username` | `username` | دریافت اطلاعات کامل کاربر با نام کاربری |
| `user/get_info_by_id` | `id` | دریافت اطلاعات کامل کاربر با آیدی عددی |
| `user/get_web_profile_info` | `username` | دریافت اطلاعات پروفایل نسخهٔ وب اینستاگرام |
| `user/get_media` | `id`, `count` | دریافت پست‌های کاربر با آیدی |
| `user/get_media_by_username` | `username`, `count` | دریافت پست‌های کاربر با نام کاربری |
| `user/get_clips` | `id`, `count` | دریافت ریلز (Clips) کاربر |
| `user/get_guides` | `id` | دریافت گایدهای کاربر |
| `user/get_tags` | `id`, `count` | دریافت پست‌هایی که کاربر در آن‌ها تگ شده |
| `user/get_followers` | `id`, `count` | دریافت لیست فالوئرها |
| `user/get_following` | `id`, `count` | دریافت لیست فالووینگ‌ها |
| `user/get_stories` | `ids` (array) | دریافت استوری‌های فعال یک یا چند کاربر |
| `user/get_highlights` | `id` | دریافت لیست هایلایت‌های کاربر |
| `user/get_live` | `id` | دریافت اطلاعات لایو فعلی کاربر (در صورت وجود) |
| `user/get_similar_accounts` | `id` | دریافت اکانت‌های مشابه/پیشنهادی |
| `user/search` | `query` | جستجوی کاربر بر اساس نام/نام کاربری |
| `user/get_about` | `id` | دریافت اطلاعات «درباره» حساب (کشور، تاریخ عضویت، تیک آبی و...) |

---

## Media — عملیات مربوط به پست/رسانه

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `media/get_info` | `id` | دریافت اطلاعات کامل یک پست با آیدی عددی |
| `media/get_info_by_shortcode` | `shortcode` | دریافت اطلاعات کامل یک پست با shortcode (کد لینک پست) |
| `media/get_comments` | `id` | دریافت کامنت‌های یک پست |
| `media/get_likes_by_shortcode` | `shortcode` | دریافت لایست‌کننده‌های یک پست با shortcode |
| `media/get_id_by_shortcode` | `shortcode` | تبدیل shortcode به آیدی عددی پست |
| `media/get_shortcode_by_id` | `id` | تبدیل آیدی عددی پست به shortcode |
| `media/search_clips` | `query` | جستجوی ریلز بر اساس عبارت متنی |

---

## Guide — گایدها

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `guide/get_info` | `id` | دریافت اطلاعات یک گایید اینستاگرام |

## Location — مکان

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `location/get_info` | `id` | دریافت اطلاعات یک لوکیشن |
| `location/get_media` | `id` | دریافت پست‌های ثبت‌شده در یک لوکیشن |
| `location/search` | `query` | جستجوی لوکیشن بر اساس نام |

## Hashtag — هشتگ

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `hashtag/get_info` | `name` | دریافت اطلاعات یک هشتگ (تعداد پست و...) |
| `hashtag/get_media` | `name` | دریافت پست‌های یک هشتگ |
| `hashtag/search` | `query` | جستجوی هشتگ‌های مرتبط |

## Highlight — هایلایت

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `highlight/get_stories` | `ids` (array) | دریافت استوری‌های داخل یک یا چند هایلایت |

## Comment — کامنت

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `comment/get_likes` | `id` | دریافت لایست‌کننده‌های یک کامنت |
| `comment/get_replies` | `id`, `media_id` | دریافت پاسخ‌های (ریپلای‌های) یک کامنت روی یک پست مشخص |

## Audio — صدا/موزیک

| Endpoint | پارامترهای بدنه | کاربرد |
|---|---|---|
| `audio/get_media` | `id` | دریافت پست‌هایی که از یک صدای مشخص استفاده کرده‌اند |
| `audio/search` | `query` | جستجوی صدا/موزیک بر اساس نام |

---

## Account Info — اطلاعات حساب BoxAPI

```
GET https://boxapi.ir/api/my
Authorization: Bearer YOUR_API_TOKEN
Content-Type: application/json
```

دریافت اطلاعات کاربری و پلن فعلی خود شما در BoxAPI (تنها اندپوینت GET و بدون بدنهٔ JSON).

---

## نمونهٔ کامل یک درخواست (الگو برای همهٔ اندپوینت‌های POST)

```bash
curl --request POST \
  --url https://boxapi.ir/api/instagram/user/get_info_by_id \
  --header "Authorization: Bearer YOUR_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{ "id": 12281817 }'
```
