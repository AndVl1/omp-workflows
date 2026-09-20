# Tasks

Пункты ниже — checklist результата, не размер одного dispatch. Внутри slice lead выделяет минимальные связные проверяемые пакеты, задаёт их write scope и проверку до реализации; зависимая wave начинается после evidence требуемого контракта. Проверки выполняются между конфликтующими волнами записи, без обязательного полного suite на каждый пакет. Финальные профиль, интеграция и полный cutover не сокращаются.

## 1. Prerequisites

- [ ] 1.1 Подтвердить завершённую acceptance `run-lifecycle` на целевой базе и сопоставить public session/claim/result seams с design §1; проверка: evidence независимой сессии рядом с CTO history и адресации позднего результата, без нового selector.
- [ ] 1.2 Выполнить ограниченный host probe nested lead: effective tools, task/batch, фактические spawn bridges и result hooks; проверка: таблица поддерживаемых surfaces, одинаковый отказ off-roster и доказательство недоступности bypass-spawn в управляемом режиме. При отсутствии enforceable seam не включать такой режим.
- [ ] 1.3 Сопоставить исправления `sdd-integration` из design Context с новой базой для mapping authority, session lifecycle, delivery и publication recovery; проверка: конкретные сохранённые сценарии и ссылки на действующие regressions либо обоснование неприменимости, без blanket cherry-pick.

## 2. Execution contract

- [ ] 2.1 Добавить versioned per-slice contract в `cto/types.ts`, `plan.ts` и validation: parent/revision, inputs, scope, dependencies, profile, lead, role-agent mappings и acceptance; проверка: несовместимое или отсутствующее назначение отвергается до worker dispatch, валидная команда принимается.
- [ ] 2.2 Добавить run-scoped child storage и parent references через существующую persistence boundary; проверка: независимые cursors двух children и восстановление прерванной публикации не создают второй источник истины.
- [ ] 2.3 Подключить delegated child context к готовому lifecycle ownership; проверка: две совместимые команды одного CTO не захватывают top-level claim, чужой run не получает их полномочия.
- [ ] 2.4 Реализовать узкое elementary routing с основанием исключения; проверка: механическое действие получает одного worker и evidence, небольшой баг с диагностикой сохраняет lead и полный профиль.
- [ ] 2.5 Добавить packet identity/revision, input contracts, write scope, критерий проверки и ссылки на readiness evidence в child contract/state; проверка: реализованное без проверки и подготовленные fixtures не считаются verified, изменение проверенных inputs делает затронутое evidence неактуальным.

## 3. Profile and dispatch

- [ ] 3.1 Расширить существующие begin/complete/advance и stage/loop transitions scoped child target без второго interpreter; проверка: нельзя пропустить обязательную проверку, допустимый fix-cycle завершается без ручного шага CTO.
- [ ] 3.2 Объединить slice admission с stage capability authorization в gates и host adapter; проверка: off-roster, неверная стадия, stale mapping и поддельный marker не запускают агента и не меняют cursor.
- [ ] 3.3 Подключить подтверждённые task/batch/bridge surfaces к одному authorization seam и исключить неподдерживаемый spawn из managed toolset; проверка: direct/wrapped вызовы имеют одинаковый policy outcome, hub communication без spawn не блокируется как запуск.
- [ ] 3.4 Связать native dispatch/result routing с child identity и идемпотентным join; проверка: повтор доставки, поздний результат и неизвестный transport state не создают дубль и не закрывают новую revision.
- [ ] 3.5 Проверять packet dependencies в admission и стабильность inputs при приёмке evidence через существующие transitions; проверка: непроверенный producer блокирует зависимую реализацию, но не независимую подготовку, проверенная версия разрешает нужную wave без нового top-level workflow.

## 4. Decisions and replanning

- [ ] 4.1 Добавить проверяемую матрицу lead/CTO/human permissions через существующую checkpoint policy; проверка: локальный fix-cycle не требует CTO, межкомандное решение доступно CTO, hard-human действие не авторизуется ими.
- [ ] 4.2 Добавить decision scope/revision и раздельные статусы доставки, ответа и применения; перевести существующие channels на trusted ingestion; проверка: replay идемпотентен, чужой и поздний ответы не разблокируют работу.
- [ ] 4.3 Связать pending decisions с dependency closure scheduler; проверка: ожидающий A не останавливает независимый B, общий вопрос блокирует всех зависимых исполнителей.
- [ ] 4.4 Подключить allocations/reservations и сохранение spend к dispatch и retry в `cto/budget.ts`; проверка: локальное продление в остатке разрешено, общий предел и конкурентное резервирование не обходятся сменой lead, estimates явно отделены от фактов.
- [ ] 4.5 Реализовать revisioned replan и lead handover с восстановлением входов из artifacts; проверка: pending worker не дублируется, неизвестная liveness требует сверки, незатронутый slice сохраняет прогресс и evidence.
- [ ] 4.6 Разделить сообщения о рабочем тупике, policy rejection и transport/recovery failure; проверка: каждый статус показывает основание и допустимое действие, не предлагает eval обход или ручную правку state.
- [ ] 4.7 Связать зафиксированное отсутствие сходимости с решением о подходе и admission следующей попытки; проверка: рост непроверенной работы не открывает зависимый фронт, увеличение allocation без действия и ожидаемого проверяемого результата не снимает блокировку, подтверждённая последовательная диагностика не объявляется тупиком только по числу итераций.

## 5. Readiness and acceptance

- [ ] 5.1 Добавить readiness evidence к существующей analysis/diagnosis стадии либо bounded prerequisite CTO child; проверка: confirmed/refuted/unknown имеют основания, отсутствующий API блокирует зависимую реализацию, локальная задача не требует большого аудита.
- [ ] 5.2 Реализовать путь bounded experiment для значимого unknown и маршрутизацию опровергнутой предпосылки в replan; проверка: недоступный host остаётся blocker, эксперимент даёт наблюдаемый результат, локальный дефект остаётся обычным fix-cycle.
- [ ] 5.3 Принимать ссылки на достаточный входной план независимо от SDD-формата; проверка: план вне OpenSpec проходит readiness без конвертации и без признания документа runtime evidence.
- [ ] 5.4 Добавить team result envelope и проверяемый parent acceptance; проверка: отсутствие обязательного evidence отвергает успех, штатный пакет CTO содержит ссылки и итоги, а не полный transcript.
- [ ] 5.5 Подключить integration acceptance dependencies и назначенных исполнителей; проверка: локально успешные несовместимые slices не завершают run, дефект возвращается lead, повторяется затронутая проверка, not-applicable имеет основание.
- [ ] 5.6 Добавить реестр review findings к child artifacts и проверку условий закрытия: identity, нарушенный критерий, evidence, owner, blocking disposition и closure; проверка: повтор не создаёт новый блокер, обязательный дефект блокирует приёмку, независимое улучшение не расширяет scope автоматически, локальный fix сохраняет независимое evidence, расширенный аудит имеет основание.

## 6. Consumer cutover and migration

- [ ] 6.1 Перевести CTO command, fullstack и private lead contracts/registration на child execution и фактически доступные tools; проверка: оба bundles проходят bug slice без ручной диспетчеризации стадий CTO и без source edits со стороны lead.
- [ ] 6.2 Обновить status/report readers для child progress, readiness, blocked dependencies, decision delivery/application, packet readiness, findings и evidence; проверка: пользователь различает реализованное, но непроверенное, локально проверенное, ожидающее интеграции, рабочую итерацию, тупик с выбранным действием, ожидание человека и infra failure.
- [ ] 6.3 Реализовать явную сверку legacy execution перед переходом, сохранение истории и отсутствие двух writers; проверка: старое done без evidence не становится новым accepted, pending unknown worker блокирует конфликтующий запуск, прерванный переход безопасно восстанавливается.
- [ ] 6.4 Удалить заменённые prompt-only authority paths и противоречащие инструкции после переключения consumers; обновить документацию команды, custom-bundle migration и changelog; проверка: все поставляемые callers используют новый контракт, старый binary не объявлен совместимым с новым state.

## 7. End-to-end verification

- [ ] 7.1 Выполнить live bug journey с неуспешной первой проверкой и повторным fix-cycle; проверка: reviewer передаёт находку lead, разрешённый writer исправляет, команда закрывает её с evidence без relay или внутренних dispatch со стороны CTO; локальный fix не вызывает автоматически полный повторный аудит.
- [ ] 7.2 Выполнить live multi-team feature journey с локальной эскалацией и интеграционным дефектом; проверка: независимая работа продолжается, ответ применяется к актуальному решению, общий успех наступает только после интеграционной приёмки.
- [ ] 7.3 Выполнить restart/replay/replan сценарии и сверить сохранённые authority/recovery гарантии из 1.3; проверка: нет дубликатов, чужого завершения, обхода roster и автоматической потери расходов.
- [ ] 7.4 Запустить build, typecheck и существующие suites после consumer cutover; сохранить regressions на реальные границы и ошибки, удалить тесты устаревших формулировок; проверка: зелёные команды и отдельное live evidence, не подменяющееся unit suite.
- [ ] 7.5 Снять trace модельных handoffs, стадий, полезных fix-итераций, ожидания решений и infra recovery в live journeys; проверка: можно отличить стоимость оркестрации от поиска дефектов без неподтверждённого обещания ускорения; удалить временные probes после сохранения evidence.
- [ ] 7.6 В live feature journey проверить последовательные packet handoffs и отсутствие сходимости: непроверенный контракт не открывает зависимую wave, независимая работа продолжается, зафиксированный тупик требует решения о подходе перед следующей попыткой, финальная acceptance по-прежнему требует всех исходных критериев и интеграции.
