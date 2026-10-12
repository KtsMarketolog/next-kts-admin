import { invalidateTwoFactorChallenge } from './db/twoFactorRepo';
import { sendSystemMail } from './mailer';

export function twoFactorDeliveryFailure() {
  return Response.json(
    { error: 'Unable to send confirmation code', code: 'TWO_FACTOR_DELIVERY_FAILED' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function deliverTwoFactorCode(input: {
  email: string;
  code: string;
  challengeId: string;
  loginSessionId: string;
}) {
  try {
    await sendSystemMail({
      to: input.email,
      subject: 'KTS: код подтверждения входа',
      text: `Код подтверждения входа: ${input.code}. Он действует 10 минут.`,
      html: `<p>Код подтверждения входа:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${input.code}</p><p>Код действует 10 минут.</p>`,
    }, { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
    return true;
  } catch {
    // SMTP errors can contain credentials, recipient addresses and server replies.
    console.error('TWO_FACTOR_DELIVERY_FAILED');
    try {
      await invalidateTwoFactorChallenge(input.challengeId, input.loginSessionId);
    } catch {
      console.error('TWO_FACTOR_CHALLENGE_INVALIDATION_FAILED');
    }
    return false;
  }
}
