/**
 * landlord-notify.ts
 *
 * Shared helper: look up the landlord for a property (via service_role,
 * which can read all landlord columns) and send them an email.
 *
 * Usage:
 *   import { sendLandlordEmail, getLandlordForProperty } from '../_shared/landlord-notify.ts';
 *   await sendLandlordEmail(supabase, app.property_id, subject, html);
 */

import { sendEmail } from './send-email.ts';

export interface LandlordInfo {
  email: string;
  contact_name: string | null;
}

export async function getLandlordForProperty(
  supabase: any,
  propertyId: string | null | undefined,
): Promise<LandlordInfo | null> {
  if (!propertyId) return null;
  try {
    const { data: prop } = await supabase
      .from('properties')
      .select('landlord_id')
      .eq('id', propertyId)
      .maybeSingle();
    if (!prop?.landlord_id) return null;

    const { data: landlord } = await supabase
      .from('landlords')
      .select('email, contact_name')
      .eq('id', prop.landlord_id)
      .maybeSingle();
    if (!landlord?.email) return null;

    return { email: landlord.email as string, contact_name: (landlord.contact_name as string | null) ?? null };
  } catch (_) {
    return null;
  }
}

export async function sendLandlordEmail(
  supabase: any,
  propertyId: string | null | undefined,
  subject: string,
  html: string,
): Promise<{ ok: boolean; email?: string }> {
  const info = await getLandlordForProperty(supabase, propertyId);
  if (!info) return { ok: false };
  try {
    const result = await sendEmail({ to: info.email, subject, html });
    return { ok: result.ok, email: info.email };
  } catch (_) {
    return { ok: false, email: info.email };
  }
}
