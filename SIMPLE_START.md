# په ساده ډول پیل — Simple Start (Visual Studio Code, بې له Docker)

دا سیستم په VS Code کې په اسانۍ سره خلاصېږي او چلېږي — **Docker ته اړتیا نشته**.
یوازې Node.js 20 او PostgreSQL 15 دې په کمپیوټر کې نصب وي.

## ۱) ZIP خلاص کړه

د `exam-management-system-source.zip` فایل ډاونلوډ کړه او خلاص یې کړه
(Extract All). دننه به دا فولډرونه وینې: `backend`، `frontend`،
`database`، `docs`، او فایلونه `run.bat` او `SIMPLE_START.md`.

## ۲) په VS Code کې پرانیزه

د `exam-management-system.code-workspace` فایل باندې دوه ځلې کلیک وکړه —
VS Code به پروژه په خپله پرانیزي.

یا: **Visual Studio Code** پرانیزه → **File → Open Folder** → هغه فولډر
وټاکه چې تا خلاص کړی دی (`exam-management-system-source`).

که VS Code د extension نصبولو پوښتنه وکړي، **Install** وټاکه
(ESLint، Prettier — دا یوازې مرسته کوونکي دي، اړین نه دي).

## ۳) سیستم چالان کړه — دوه اسانه لارې (یوه وټاکه)

### لاره الف: `run.bat` باندې دوه ځلې کلیک وکړه (تر ټولو اسانه)

په فولډر کې د `run.bat` فایل باندې دوه ځلې کلیک وکړه. هغه به:

1. Node.js او PostgreSQL وګوري؛
2. یو ځل دې نه د PostgreSQL پاسورډ وغواړي (هغه پاسورډ چې د PostgreSQL
   د نصبولو پر مهال دې د `postgres` کارن لپاره ټاکلی و)؛
3. `backend/.env` جوړ کړي، ډیټابېس جوړ کړي او جدولونه جوړ کړي؛
4. backend او frontend په دوو جلا کړکیو کې چالان کړي؛
5. براوزر کې http://localhost:5173 پرانیزي.

### لاره ب: په VS Code کې Task وچلوه

1. لومړی یو ځل `run.bat` وچلوه (یوازې د لومړي ځل لپاره — تر څو ډیټابېس
   او `backend/.env` جوړ شي).
2. بیا په VS Code کې `Ctrl + Shift + B` کېکاږه.
3. **Run Everything (VS Code, no Docker)** وټاکه.
4. براوزر کې پرانیزه: http://localhost:5173

نور Taskونه هم شته (`Ctrl + Shift + B`):
- **Setup + Migrate** — ډیټابېس او جدولونه جوړوي (یوازې لومړی ځل؛
  `backend/.env` کې دې `DATABASE_URL` سم وي)
- **Start Backend** — یوازې API چالانوي: http://localhost:5000
- **Start Frontend** — یوازې ویب پاڼه چالانوي: http://localhost:5173
- **Start All (Docker)** — یوازې که Docker لرې (لاندې وګوره)

## ۴) کله چې دې نه پاسورډ وغوښتل شو

کله چې `run.bat` ستا د PostgreSQL پاسورډ وغواړي، هغه پاسورډ ولیکه چې
د PostgreSQL د نصبولو پر مهال دې ټاکلی و. (پاسورډ به دې د لیکلو پر مهال
په توره کړکۍ کې ښکاري — دا عادي ده.) دا پاسورډ یوازې په ستا کمپیوټر
کې په `backend/.env` فایل کې ساتل کېږي — هېڅکله یې په چټ کې مه لېږه
او `backend/.env` فایل هېڅچا ته مه ورکوه.

> که ستا پاسورډ کې `@` `#` `%` `&` یا ځای (space) وي، نو کېدای شي کار
> ونه کړي — په دې صورت کې په PostgreSQL کې خپل پاسورډ یوازې له تورو
> او شمیرو جوړ کړه.

## ۵) ویب پاڼه پرانیزه

په Chrome کې دا پرانیزه:

```
http://localhost:5173
```

که پاڼه سمدستي خلاصه نه شوه، ۳۰ ثانیې انتظار وکړه او Refresh کېکاږه
(لومړی ځل د پکېجونو نصبولو وخت نیسي — انټرنټ ته یوازې لومړی ځل اړتیا ده).

## ۶) لومړی Super Admin جوړ کړه

په پاڼه کې د **Create the first Super Admin** فورم ډک کړه:

- **Full name:** melad
- **Email:** meladakhundzada@gmail.com
- **Password:** خپل پاسورډ وټاکه — لږ تر لږه **۸ توري** باید وي.
  پاسورډ دې هېڅکله په چټ کې مه لېږه او په هېڅ فایل کې مه لیکئ.

بیا **Create Super Admin** کېکاږه او په هماغه ایمیل او پاسورډ سره ننوځه.

## که ستونزه وي

- **Node.js is NOT installed** — Node.js 20 LTS له https://nodejs.org/
  نصب کړه، بیا `run.bat` بیا وچلوه.
- **psql was not found** — PostgreSQL 15 نصب کړه
  (https://www.postgresql.org/download/windows/)، او د هغه د `bin`
  فولډر په PATH کې واچوه (معمولاً `C:\Program Files\PostgreSQL\15\bin`).
- **Could not reach PostgreSQL** — PostgreSQL service چالان کړه
  (Windows Services → `postgresql-x64-15` → Start)، او ډاډ ترلاسه کړه
  چې پاسورډ دې سم دی.
- **Migration failed / relation already exists** — جدولونه له مخکې جوړ
  دي؛ `run.bat` بیا وچلوه.
- **Port already in use** — پخوانی سیستم روان دی؛ هغه دوه تورې کړکۍ
  وتړه (backend او frontend) او بیا هڅه وکړه.
- **Database connection refused** — لومړی ډیټابېس چالان کړه، بیا backend.
- **Login نه کېږي** — ډاډ ترلاسه کړه چې لومړی Super Admin دې جوړ کړی دی
  (پورته ۶م ګام) او پاسورډ دې لږ تر لږه ۸ توري لري.

د سیستم بندول: هغه دوه تورې کړکۍ وتړه (په هره یوه کې `Ctrl+C` کېکاږه).

نور تفصیل: [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)،
[docs/USER_GUIDE.md](docs/USER_GUIDE.md) او
[docs/OFFLINE_GUIDE.md](docs/OFFLINE_GUIDE.md).

## بله لاره: Docker (یوازې که Docker لرې)

که Docker Desktop دې نصب وي، نو `start.bat` باندې دوه ځلې کلیک وکړه،
یا په VS Code کې `Ctrl+Shift+B` → **Start All (Docker)** وټاکه، بیا پرانیزه:
http://localhost:8080 — دا لاره نوره اړینه نه ده، پورتنۍ لاره بس ده.
