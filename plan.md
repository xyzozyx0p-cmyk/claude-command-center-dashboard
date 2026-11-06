# Claude Command Center — план

## Продукт

Защищённая адаптивная панель для ежедневного управления Claude Code через существующий Control Plane API на Instabox. Пользователь входит через Manus OAuth, а браузер обращается только к серверной части сайта; URL и токен Control Plane никогда не попадают в клиентский bundle.

## Дизайн

### Рассмотренные направления

- Операционный янтарь (вероятность 0.06): тёмная диспетчерская с янтарными сигналами и терминальной типографикой.
- Полярная телеметрия (вероятность 0.07): светлая холодная телеметрия с синими индикаторами.
- Фосфорный контур (вероятность 0.05): графитовый терминал с зелёными акцентами.

Выбрано направление **Операционный янтарь**.

- **Design Movement:** современная industrial operations room / command-line dashboard.
- **Core Principles:** сигнал важнее декора; состояние видно за один взгляд; действия обратимы и подтверждаемы; плотность информации без визуального шума.
- **Color Philosophy:** почти чёрный графит снижает усталость, янтарный обозначает действие и внимание, холодный серо-синий служит нейтральным слоем, зелёный/красный резервируются для доступности и ошибок.
- **Layout Paradigm:** широкая рабочая лента с узкой навигационной рейкой, sticky status header и resizable panels вместо центрированной карточной страницы.
- **Signature Elements:** amber signal rail, моноширинные execution IDs, тонкая grid-линия только в terminal/log areas.
- **Interaction Philosophy:** каждое действие сообщает pending/success/error, опасные операции требуют явного подтверждения, live-поверхности не блокируют навигацию.
- **Animation:** короткие 150–220ms transitions, мягкий pulse только для live/working состояния, никаких постоянных декоративных движений.
- **Typography System:** IBM Plex Sans для интерфейса, IBM Plex Mono для команд, логов, идентификаторов и значений состояния.
- **Brand Essence:** пульт, который превращает удалённого агента в наблюдаемую операционную систему; точный, спокойный, инженерный.
- **Brand Voice:** коротко и по делу. Примеры: «Сессия жива. Можно давать задачу.» и «Команда принята — вывод появится здесь.»
- **Wordmark & Logo:** компактный знак из двух вертикальных янтарных импульсов и wordmark `CLAUDE / CONTROL`.
- **Signature Brand Color:** `#F2A900` — amber signal.

## Реализация

- Frontend: React + Tailwind в starter-проекте, одна рабочая панель без лишних страниц.
- Auth: сохранить starter Manus OAuth и `webdev_app_session` cookie.
- Backend: Express endpoint `/api/control/*`, который проверяет `ctx.user`, добавляет серверные `CONTROL_PLANE_URL` и `CONTROL_PLANE_TOKEN`, проксирует status/models/Claude/files/command и не отдаёт токен клиенту.
- Streaming: polling для status/output и WebSocket bridge для интерактивного терминала; браузер не получает исходный Control Plane token.
- Files: multipart upload/download через серверный proxy; ограничения path остаются на Control Plane.
- Persistence: не добавлять БД в первую итерацию; история текущей панели живёт в памяти браузера, а авторитетное состояние остаётся на Control Plane.
- Runtime: использовать server-only environment variables, health endpoint `/api/health`, route manifest `/manus-routes.json`.
- Validation: TypeScript check, production build, HTTP health/route manifest и read-only code review.
