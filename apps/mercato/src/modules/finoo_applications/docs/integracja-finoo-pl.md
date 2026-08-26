# Integracja formularza finoo.pl/apply z Open Mercato

- Stan kontraktu: 24 sierpnia 2026 r.
- Endpoint produkcyjny: `POST https://finoo.om.they.dev/api/finoo_applications/intake`
- Aktualna wersja rejestru zgód: `finoo-apply-2026-08-19-7e72cbeb`

## 1. Architektura

Wywołanie musi wychodzić z backendu finoo.pl. Kod uruchomiony w przeglądarce nie może znać sekretu ani wywoływać endpointu Open Mercato bezpośrednio.

```text
przeglądarka finoo.pl/apply
        |
        | dane formularza
        v
backend finoo.pl
        |
        | mapowanie + podpis HMAC dokładnych bajtów JSON
        v
https://finoo.om.they.dev/api/finoo_applications/intake
```

Sekret HMAC zostanie przekazany osobnym, bezpiecznym kanałem. Nie wolno umieszczać go w kodzie frontendu, repozytorium, logach ani systemie analitycznym.

## 2. Kiedy wysyłać dane

Dla jednego wniosku backend finoo.pl generuje jeden stabilny `leadId`. Ten sam `leadId` jest używany w każdej kolejnej wysyłce, natomiast każda próba dostarczenia nowej wersji danych otrzymuje nowy `Finoo-Message-Id`. Każdy payload musi zawierać `completed` jako JSON boolean; brak pola albo wartość tekstowa powoduje `400`. Wycofane pole `przeszedl_caly_wniosek` jest odrzucane również wtedy, gdy payload zawiera poprawne `completed`.

| Zdarzenie formularza | Wartość `completed` | Oczekiwany etap CRM |
|---|---:|---|
| Przejście z kroku 1 „Firma i kontakt” do kroku 2 | `false` | Brak Deala, dopóki brakuje danych wnioskodawcy; intake zostaje zapisany |
| Przejście z kroku 2 „Wnioskodawca” do kroku 3 | `false` | `Created` |
| Wysłanie kroku 3 „Zgody” | `true` | `Submitted` |
| Automatyczna dyskwalifikacja | `true` + `disqualified: true` | `Closed` |

Wnioski zdyskwalifikowane zapisujemy. Aktualnie osiągalne w UI przyczyny automatyczne to zaległości ZUS/US, działalność krótsza niż sześć miesięcy oraz połączenie obu warunków. Wariant „obrót poniżej 5 000 zł” istnieje w logice strony, ale przy obecnych opcjach formularza nie jest osiągalny.

## 3. Nagłówki i podpis

Każde żądanie zawiera:

```text
Content-Type: application/json
Finoo-Message-Id: <nowy nonce base64url, 16–128 znaków>
Finoo-Timestamp: <czas Unix w pełnych sekundach>
Finoo-Signature: v1,<base64 HMAC-SHA256>
```

Podpisujemy kolejno:

1. bajty ASCII tekstu `<message-id>.<timestamp>.`;
2. dokładne bajty body wysyłane w HTTP.

Nie wolno po podpisaniu ponownie parsować, formatować ani serializować JSON. Dopuszczalne odchylenie zegara to pięć minut. Maksymalny rozmiar dokładnego body wynosi 65 536 bajtów.

### Referencyjna implementacja Node.js

```js
import { createHmac, randomBytes } from 'node:crypto'

const endpoint = 'https://finoo.om.they.dev/api/finoo_applications/intake'
const secret = process.env.FINOO_APPLICATION_SIGNING_SECRET

export async function sendFinooApplication(payload, messageId = randomBytes(24).toString('base64url')) {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Brak poprawnego sekretu FINOO_APPLICATION_SIGNING_SECRET')
  }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = createHmac('sha256', secret)
    .update(`${messageId}.${timestamp}.`, 'ascii')
    .update(body)
    .digest('base64')

  const response = await fetch(endpoint, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'finoo-message-id': messageId,
      'finoo-timestamp': timestamp,
      'finoo-signature': `v1,${signature}`,
    },
  })

  const result = await response.json()
  return { status: response.status, result, messageId }
}
```

Przy ponowieniu po błędzie transportowym, `429` lub `5xx` funkcja musi użyć dokładnie tego samego `messageId`, `timestamp`, `body` i podpisu, dopóki timestamp mieści się w pięciominutowym oknie. Najbezpieczniej zapisać te wartości w durable outboxie przed pierwszą próbą wysyłki. Po wygaśnięciu okna należy utworzyć nową dostawę tego samego logicznego payloadu: z nowym `messageId`, aktualnym timestampem i nowym podpisem, ale z niezmienionym stabilnym `leadId`.

## 4. Mapowanie kroków formularza

### Firma i finansowanie

| Pole stanu formularza finoo.pl | Pole endpointu | Uwagi / cel w CRM |
|---|---|---|
| identyfikator leada z backendu | `leadId` | Stabilny string zgodny z `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`; nigdy liczba |
| `nip` | `nip` | 10 cyfr; Company `tax_number` |
| `companyName` | `companyName` | Nazwa Company i Deala |
| `businessType` | `businessType` | `jdg` albo `company`; mapowane odpowiednio na `sole_trader` lub `private_limited_company` |
| `businessStartDate` | `businessStartDate` | ISO `YYYY-MM-DD` |
| `monthlyTurnover` | `earnings` | Wysyłać wartość liczbową jako string, np. `"50000"`; zapis do pól `earnings` i `turnover` |
| `amount` | `amount` | Kwota jako string liczbowy, np. `"100000"` |
| `months` | `months` | Liczba miesięcy jako string, np. `"12"` |
| `reason` | `reason` | Opis Deala |
| `arrearsUsZus` | `arrearsUsZus` | Boolean |
| `phonePrefix` | `phonePrefix` | Np. `+48` |
| `phone` | `phone` | Sam numer; bez formatowania prezentacyjnego |
| `email` | `email` | Adres kontaktowy wnioskodawcy |
| `representatives` | `representatives` | Tylko dla spółki; tablica obiektów `{ firstname, lastname, email }`, maks. 20 |

Nie wysyłać dodatkowego pola prezentacyjnego `turnover`; jego wartość liczbowa ma trafić do `earnings`. Pole formularza `propertyCollateral` nie ma obecnie przygotowanego pola docelowego w CRM i nie powinno być wysyłane. Dodanie jego obsługi wymaga osobnej zmiany kontraktu i pola CRM.

### Wnioskodawca i dokument tożsamości

| Pole formularza | Pole endpointu | Uwagi |
|---|---|---|
| `firstName` | `name` | Imię |
| `lastName` | `surname` | Nazwisko |
| `pesel` | `pesel` | 11 cyfr |
| JDG | `position: "Właściciel"` | Wartość istniejącego słownika CRM |
| stanowisko w spółce | `position` | Jedna z wartości słownika CRM, np. `Prezes zarządu`, `Wiceprezes zarządu`, `Członek zarządu`, `Dyrektor finansowy`, `Prokurent`, `Wspólnik` |
| dowód osobisty | `idType: "IDCARD"` + `idCard`, `idCardIssued`, `idCardExpiry` | Daty ISO `YYYY-MM-DD`; kraj jest wyznaczany jako `PL`, więc `country` można pominąć; jeśli jest przesłany, musi mieć wartość `PL` |
| paszport | `idType: "PASSPORT"` + `passport`, `passportCountryCode`, `passportIssued`, `passportExpiry` | Kod kraju, np. `PL` albo `UK` |
| mDowód | `idType: "DIGITCARD"` + `digitCard`, `digitCardIssued`, `digitCardExpiry` | Daty ISO `YYYY-MM-DD`; kraj jest wyznaczany jako `PL`, więc `country` można pominąć; jeśli jest przesłany, musi mieć wartość `PL` |
| `propertyCommunity` dla JDG | `NovaLend-propertyCommunity` | Boolean |

### Zgody

Każda wysyłka zawierająca decyzję dotyczącą zgody — także draft z kroku 1 — musi zawierać:

```json
{
  "consentVersion": "finoo-apply-2026-08-19-7e72cbeb"
}
```

Mapowanie decyzji:

| Stan formularza finoo.pl | Pole endpointu |
|---|---|
| zaznaczona co najmniej jedna zgoda na kontakt | `contactConsent` |
| `contactConsentEmail` | `contactEmail` |
| `contactConsentSms` | `contactSms` |
| `contactConsentPhone` | `contactPhone` |
| `marketingEmail` | `emailConsent` |
| `marketingSms` | `smsConsent` |
| `marketingPhone` | `telefonConsent` |
| `partnersEmail` | `emailConsent2` |
| `partnersSms` | `smsConsent2` |
| `partnersPhone` | `telefonConsent2` |
| akceptacja regulaminu i polityki prywatności | `acceptTerms` |

Kontakt w sprawie wniosku, marketing FINOO.PL i marketing partnerów są trzema odrębnymi grupami. Nie wolno używać obecnego skrótu `contactConsentEmail || marketingEmail` ani analogicznych operacji OR dla SMS i telefonu, ponieważ utraciłyby one informację, której zgody faktycznie udzielono.

Bieżący frontend serializuje zgody NovaLend w starszym układzie nazw. Backend finoo.pl musi zastosować poniższe mapowanie:

| Bieżący payload strony | Kanoniczny payload endpointu | Znaczenie |
|---|---|---|
| `jdgConsent.jdg` | `jdgConsent.jdg1` | BIK dla JDG |
| `jdgConsent.jdg1` | `jdgConsent.jdg2` | BIG InfoMonitor dla JDG |
| `jdgConsent.jdg2` | `jdgConsent.jdg3` | KRD dla JDG |
| `legalConsent.legal` | `legalConsent.legal1` | BIK dla spółki |
| `legalConsent.legal1` | `legalConsent.legal2` | KRD dla spółki |

Do endpointu wysyłamy wyłącznie decyzje, np.:

```json
{
  "jdgConsent": {
    "jdg1": { "selected": true },
    "jdg2": { "selected": true },
    "jdg3": { "selected": true }
  }
}
```

Nie wysyłamy tekstów zgód, czasu z przeglądarki ani nazwy użytkownika. Open Mercato dobiera zatwierdzony tekst i kod po `consentVersion` oraz zapisuje własny czas przyjęcia.

### Kontomatik, wynik i atrybucja

| Pole formularza | Pole endpointu | Uwagi |
|---|---|---|
| ukończenie połączenia | `kontomatikCompleted` | Boolean |
| token Kontomatik | nie wysyłać | Token nie może trafić do CRM, logów ani durable outboxa integratora |
| ukończenie formularza | `completed` | Boolean; `true` dla ukończonego formularza, `false` dla draftu |
| automatyczna dyskwalifikacja | `disqualified` | Boolean; dla dyskwalifikacji `true` |
| powód dyskwalifikacji | `disqualification_message` | Tekst przeznaczony do pola statusu Deala |
| kod afiliacyjny | `affiliate_code` | Opcjonalny |
| UTM/click IDs/referrery | pola o tych samych nazwach | Opcjonalne: `utm_*`, `first_utm_*`, `gclid`, `fbclid`, `msclkid`, `landingPage`, `initialReferrer`, `lastReferrer`, `session_started_at`, `first_touch_at`, `last_touch_at`, `traffic_source` |

## 5. Minimalny payload końcowy — JDG

```json
{
  "leadId": "finoo_01j6example01",
  "consentVersion": "finoo-apply-2026-08-19-7e72cbeb",
  "completed": true,
  "leadType": "business",
  "companyName": "Przykładowa Firma",
  "nip": "1234567890",
  "businessType": "jdg",
  "businessStartDate": "2024-01-02",
  "earnings": "50000",
  "amount": "100000",
  "months": "12",
  "reason": "Kapitał obrotowy",
  "name": "Jan",
  "surname": "Kowalski",
  "pesel": "90010112345",
  "phonePrefix": "+48",
  "phone": "500600700",
  "email": "jan.kowalski@example.com",
  "position": "Właściciel",
  "idType": "IDCARD",
  "idCard": "ABC123456",
  "idCardIssued": "2023-01-02",
  "idCardExpiry": "2033-01-02",
  "country": "PL",
  "arrearsUsZus": false,
  "NovaLend-propertyCommunity": true,
  "acceptTerms": true,
  "contactConsent": true,
  "contactEmail": true,
  "contactSms": false,
  "contactPhone": true,
  "emailConsent": false,
  "smsConsent": false,
  "telefonConsent": false,
  "emailConsent2": false,
  "smsConsent2": false,
  "telefonConsent2": false,
  "jdgConsent": {
    "jdg1": { "selected": true },
    "jdg2": { "selected": true },
    "jdg3": { "selected": true }
  },
  "kontomatikCompleted": false
}
```

## 6. Odpowiedzi, retry i idempotencja

| Status | Znaczenie | Zachowanie integratora |
|---:|---|---|
| `202` | Intake trwale przyjęty; projekcja CRM działa asynchronicznie | Sukces, nie wysyłać ponownie |
| `200` + `duplicate: true` | Te same `messageId` i body zostały już przyjęte | Sukces |
| `400` | Błędny nonce/czas/JSON/schema/wersja zgód | Nie ponawiać bez poprawy danych |
| `401` | Błędny podpis | Nie ponawiać; sprawdzić sekret i dokładne bajty |
| `409` | Ten sam `messageId`, ale inne body | Błąd implementacji outboxa; nie ponawiać automatycznie |
| `413` | Body powyżej 65 536 bajtów | Nie ponawiać bez zmniejszenia body |
| `415` | Inny `Content-Type` | Ustawić `application/json` |
| `429` | Limit ruchu | Ponowić z exponential backoff i tym samym podpisanym żądaniem; respektować `Retry-After` |
| `5xx` | Chwilowa niedostępność | Ponowić z exponential backoff i tym samym podpisanym żądaniem |

Zalecany backoff: 1 s, 2 s, 4 s, 8 s, 16 s, następnie maks. 30 s z losowym jitterem. Timeout sieciowy traktujemy jak nieznany wynik — w aktywnym pięciominutowym oknie ponawiamy identyczne żądanie i nie generujemy nowego `messageId`; po wygaśnięciu okna stosujemy nową kopertę dostawy opisaną wyżej.

## 7. Zasady logowania i bezpieczeństwa

W logach wolno zapisać: `leadId`, `Finoo-Message-Id`, status HTTP, `intakeId`, numer próby i bezpieczny kod błędu.

Nie logować: body, podpisu, sekretu, NIP, PESEL, numeru dokumentu, telefonu, e-maila, tekstów zgód, tokenu Kontomatik ani surowego IP klienta.

## 8. Checklista odbiorowa po stronie finoo.pl

- Backend generuje stabilny string `leadId` i przechowuje podpisane żądania w outboxie.
- Draft po kroku 1 i draft po kroku 2 używają tego samego `leadId`, ale różnych `Finoo-Message-Id`.
- Final albo automatyczne odrzucenie ma `completed: true`.
- Każda decyzja dotycząca zgody ma aktualny `consentVersion`.
- Zgody kontaktowe, marketingowe FINOO.PL i partnerskie pozostają rozdzielone.
- Stare klucze zgód NovaLend są przemapowane na układ kanoniczny.
- `monthlyTurnover` jest wysyłany jako `earnings`; `turnover` i `propertyCollateral` nie są wysyłane.
- `kontomatikToken` nigdy nie opuszcza zaufanego procesu, który go potrzebuje.
- HMAC obejmuje dokładnie te same bajty, które trafiają do HTTP.
- Retry `429`/`5xx`/timeout odtwarza identyczne żądanie.
- Integrator traktuje `202` oraz `200 duplicate` jako sukces.

Przed przełączeniem produkcyjnego ruchu należy wspólnie wykonać testy: draft kroku 1, draft kroku 2, final dla JDG i spółki, trzy rodzaje dokumentu, reprezentantów spółki, dobrowolne zgody `true`/`false`, Kontomatik `true`/`false`, trzy osiągalne automatyczne dyskwalifikacje, duplicate, conflict, zły podpis, stary timestamp, brak wersji zgód, zły content type i przekroczenie limitu body.
