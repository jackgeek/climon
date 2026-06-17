import type { Locale } from "../i18n/t.js";

/** Bump when the licence text changes; a newer value re-triggers acceptance. */
export const EULA_VERSION = "1";

export type EulaDocument = { version: string; text: string };

const EN_TEXT = `climon End User Licence Agreement (Version ${EULA_VERSION})

IMPORTANT — READ CAREFULLY. This End User Licence Agreement ("Agreement") is a
legal agreement between you ("Licensee") and Brodie Jack Allan, a sole trader
("Licensor"), for the climon software, including the executables, bundled files,
and documentation ("Software"). By typing "I AGREE", installing, or using the
Software, you agree to be bound by this Agreement. If you do not agree, do not
install or use the Software.

1. LICENCE GRANT. The Licensor grants you a personal, non-exclusive,
   non-transferable, revocable licence to install and use the version of the
   Software you have obtained, free of charge, subject to this Agreement.

2. PRICING RESERVATION. The Software is currently provided free of charge. The
   Licensor reserves the right to change the terms, features, and pricing of
   future versions. This Agreement governs only the version you have installed.

3. RESTRICTIONS. Except to the extent permitted by mandatory applicable law, you
   may not: (a) redistribute, sell, sublicense, rent, or lease the Software;
   (b) reverse engineer, decompile, or disassemble the Software; or (c) create
   derivative works from the Software.

4. OWNERSHIP. The Software is licensed, not sold. All right, title, and interest
   in and to the Software, including all intellectual property rights, remain
   with the Licensor. All rights not expressly granted are reserved.

5. TELEMETRY. The Software can optionally send anonymous usage telemetry. This is
   OFF by default and is only enabled if you explicitly opt in. When enabled,
   telemetry is keyed solely by a random, anonymous install identifier and does
   not include personal information, session output, command contents, file
   paths, or hostnames. You may disable telemetry at any time.

6. NO WARRANTY. THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT
   WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
   IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
   NON-INFRINGEMENT, TO THE MAXIMUM EXTENT PERMITTED BY LAW.

7. LIMITATION OF LIABILITY. TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE LICENSOR
   SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY LOSS OR DAMAGE WHATSOEVER,
   WHETHER MONETARY OR OTHERWISE, ARISING OUT OF OR IN CONNECTION WITH THE
   SOFTWARE OR THIS AGREEMENT, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

8. INDEMNITY. You agree to defend, indemnify, and hold the Licensor harmless from
   and against any and all claims, liabilities, losses, damages, costs, and
   expenses (including reasonable legal fees) arising out of or related to your
   use of the Software or your breach of this Agreement.

9. TERMINATION. This Agreement and the licence granted terminate automatically,
   without notice, if you breach any of its terms. On termination you must cease
   all use of the Software and remove all copies.

10. GOVERNING LAW. This Agreement is governed by and construed in accordance with
    the laws of Ireland, and the parties submit to the exclusive jurisdiction of
    the courts of Ireland.

11. ENTIRE AGREEMENT. This Agreement is the entire agreement between you and the
    Licensor regarding the Software and supersedes any prior agreements.
`;

export const EULA_TEXTS: Record<Locale, EulaDocument> = {
  en: { version: EULA_VERSION, text: EN_TEXT },
};

/** Returns the EULA document for a locale, falling back to English. */
export function getEula(locale?: Locale): EulaDocument;
export function getEula(locale: Locale | string = "en"): EulaDocument {
  return EULA_TEXTS[locale as Locale] ?? EULA_TEXTS.en;
}
