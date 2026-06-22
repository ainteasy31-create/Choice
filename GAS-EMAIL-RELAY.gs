// ============================================================
// CHOICE PROPERTIES — GAS EMAIL RELAY — Bilingual EN/ES
// =============================================================
//
// CANONICAL UX COPY (mirror of js/cp-copy.js + supabase/functions/_shared/copy.ts)
// Edits to wording MUST be made in all three locations to stay consistent.
//   Flow: Apply -> Payment -> Review -> Approval -> Reservation -> Lease -> Move-In
var COPY = {
  en: {
    feeStatement: 'An application fee is required after submission. Our team will contact you to securely complete payment before your application is reviewed.',
    feeReinforcement: 'Applications are only activated after payment is completed.',
    reviewTime: 'Applications are typically processed within 24 to 72 hours after payment is completed.',
    reviewBehavior: 'Faster decisions are often made for applicants who complete all steps promptly, provide accurate information, and remain responsive.',
    reviewPriority: 'Applicants who act quickly are often prioritized in the review process.',
    statusActiveReview: 'In Active Review',
    submissionConfirm: 'Your application is now being evaluated for qualification. Payment is the next step to activate review.',
    holdingDefinition: 'The holding fee temporarily reserves the property and removes it from active availability while your lease is being finalized.',
    holdingNoHoldRisk: 'Without a holding fee, the property remains available to other approved applicants.',
    holdingUrgency: 'Holding requests are time-sensitive and typically must be completed within 24 to 48 hours.',
    holdingTrust: 'This fee is fully credited toward your move-in costs and is not an additional charge.',
    selectedHeadline: 'You have been selected based on your application.',
    selectionTimeSensitive: 'This selection is time-sensitive — units are offered on a first-completion basis among approved applicants.',
    leaseFinalStage: 'You are now entering the final stage of securing your approved unit.',
    leaseWindow: 'Please complete your lease within 48 hours to maintain your reservation.'
  },
  es: {
    feeStatement: 'Se requiere un cargo de solicitud después de enviar su solicitud. Nuestro equipo lo contactará para completar el pago de forma segura antes de revisar su solicitud.',
    feeReinforcement: 'Las solicitudes solo se activan después de completar el pago.',
    reviewTime: 'Las solicitudes generalmente se procesan dentro de 24 a 72 horas después de completar el pago.',
    reviewBehavior: 'Las decisiones más rápidas suelen tomarse para quienes completan todos los pasos con prontitud, brindan información precisa y responden a tiempo.',
    reviewPriority: 'Los solicitantes que actúan rápidamente suelen tener prioridad en el proceso de revisión.',
    statusActiveReview: 'En Revisión Activa',
    submissionConfirm: 'Su solicitud ahora está siendo evaluada para calificación. El siguiente paso es el pago para activar la revisión.',
    holdingDefinition: 'El cargo de reserva retiene temporalmente la propiedad y la retira de la disponibilidad activa mientras se finaliza su contrato.',
    holdingNoHoldRisk: 'Sin un cargo de reserva, la propiedad permanece disponible para otros solicitantes aprobados.',
    holdingUrgency: 'Las solicitudes de reserva son sensibles al tiempo y normalmente deben completarse dentro de 24 a 48 horas.',
    holdingTrust: 'Este cargo se acredita en su totalidad a sus costos de entrada y no es un cargo adicional.',
    selectedHeadline: 'Ha sido seleccionado/a según su solicitud.',
    selectionTimeSensitive: 'Esta selección es sensible al tiempo — las unidades se ofrecen por orden de finalización entre los solicitantes aprobados.',
    leaseFinalStage: 'Ahora está entrando en la etapa final para asegurar su unidad aprobada.',
    leaseWindow: 'Por favor complete su contrato dentro de 48 horas para mantener su reserva.'
  }
};
//
// Full EN/ES bilingual support for all applicant-facing emails.
// Admin/landlord emails remain English (internal use).
//
// Language flows:
//   applicant sets language on apply.html
//   -> saved as preferred_language on applications table
//   -> passed as data.preferred_language in every GAS payload
//   -> t(key, lang) renders the correct string
//   -> html[lang] and subject lines match the language
//
// Setup:
//   1. Paste into script.google.com
//   2. Deploy as Web App (Execute as: Me, Access: Anyone)
//   3. Copy Web App URL -> Supabase Edge Function Secrets as GAS_EMAIL_URL
//   Set in Script Properties:
//     RELAY_SECRET, ADMIN_EMAILS, COMPANY_NAME,
//     COMPANY_EMAIL, COMPANY_PHONE, DASHBOARD_URL
// ============================================================

// ── Configuration ─────────────────────────────────────────
function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    secret:       props.getProperty('RELAY_SECRET')   || '',
    adminEmails:  (props.getProperty('ADMIN_EMAILS')  || 'your@email.com').split(',').map(function(e){ return e.trim(); }),
    companyName:  props.getProperty('COMPANY_NAME')   || 'Choice Properties',
    companyEmail: props.getProperty('COMPANY_EMAIL')  || 'support@choiceproperties.com',
    companyPhone: props.getProperty('COMPANY_PHONE')  || 'YOUR-PHONE-NUMBER',
    dashboardUrl: props.getProperty('DASHBOARD_URL')  || 'https://your-domain.com',
  };
}

// ============================================================
// BILINGUAL STRING TABLE
// ============================================================
var EMAIL_STRINGS = {
  en: {
    dear: 'Dear', hello: 'Hello', questions: 'Questions?', textUs: 'Text:',
    closingTeam: 'Choice Properties Leasing Team',
    closingSystem: 'Choice Properties System',
    headerSub: 'Professional Property Management',
    tagline: 'Your trust is our standard.',
    confidential: 'This message is intended solely for the named recipient and contains confidential information. If you received this in error, please disregard and delete it. Equal Housing Opportunity.',
    appConfirmSubject: '[Choice Properties] Official Application Confirmation \u2014 Ref: ',
    appConfirmTitle: 'Application Successfully Received',
    appConfirmStatusPending: '\u23f3  Awaiting Application Fee \u00b7 Review Pending',
    appConfirmStatusFree: '\u2713  Application Received \u2014 No Fee Required \u00b7 Review Pending',
    appConfirmIntro: 'Thank you for choosing Choice Properties. We have officially received your rental application and your file has been securely recorded in our system. This email constitutes your formal acknowledgment of receipt. Please retain it for your records.',
    appSummaryLabel: 'Application Summary', appIdLabel: 'Application ID',
    applicantNameLabel: 'Applicant Name', propertyInterestLabel: 'Property of Interest',
    toBeConfirmed: 'To be confirmed', requestedMoveInLabel: 'Requested Move-In',
    notSpecified: 'Not specified', leaseTermLabel: 'Lease Term',
    appFeeLabel: 'Application Fee', emailOnFileLabel: 'Email on File',
    phoneOnFileLabel: 'Phone on File', freeNoFee: 'Free \u2014 No application fee',
    paymentMethodsLabel: 'Your Selected Payment Methods',
    payFeeTitle: 'Application Fee',
    payFeeIntro: 'You have indicated the following preferred payment methods. Our team will reach out within 24 hours to arrange collection of your application fee.',
    noFeeTitle: '\u2713 No Application Fee',
    noFeeDesc: 'There is no application fee for this property. Your application has been received and will proceed directly to review.',
    whatHappensNext: 'What Happens Next',
    nextFee1Title: 'Payment Arrangement',
    nextFee1Body: 'A member of our leasing team will contact you within 24 hours via text at',
    nextFee1Body2: 'to coordinate your application fee of',
    nextFee2Title: 'Payment Confirmation',
    nextFee2Body: 'Once your fee is received, you will receive an email notification and your application will advance to review.',
    nextFee3Title: 'Application Review',
    nextFee3Body: 'Applications are typically processed within 24 to 72 hours after payment is completed. Applicants who complete steps promptly are often prioritized in the review queue.',
    nextFee4Title: 'Decision Notification',
    nextFee4Body: 'You will be notified of our decision via email. If approved, our leasing team will prepare your lease agreement for signature.',
    nextFree1Title: 'Application Review',
    nextFree1Body: 'Applications are typically processed within 24 to 72 hours of receipt. Applicants who respond promptly to any follow-up requests are often prioritized.',
    nextFree2Title: 'Decision Notification',
    nextFree2Body: 'You will be notified of our decision via email once a determination has been made.',
    nextFree3Title: 'If Approved',
    nextFree3Body: 'Our leasing team will prepare your lease agreement for electronic signature and guide you through the next steps.',
    saveAppIdTitle: 'Important \u2014 Save Your Application ID',
    saveAppIdBody: 'Your application ID is', saveAppIdBody2: 'Save this reference number to track your application status at any time.',
    trackBtn: 'Track My Application', orVisit: 'Or visit:',
    closingNote: 'Should you have any questions prior to hearing from our team, please do not hesitate to reach out.',
    payConfirmSubject: '[Choice Properties] Application Fee Confirmed \u2014 ',
    payConfirmTitle: 'Application Fee Confirmed',
    payConfirmStatus: '\u2713  Payment Received \u2014 Application Now Under Review',
    payConfirmIntro: 'We are pleased to confirm that your application processing fee has been received and officially recorded. Your application is now active and has been placed in our formal review queue.',
    payConfirmSectionLabel: 'Payment Confirmation', payConfirmSuccess: '\u2713 Payment Successfully Received',
    payConfirmAppId: 'Application ID', payConfirmApplicant: 'Applicant',
    payConfirmDate: 'Payment Date', payConfirmStatus2: 'Status', underReview: 'In Active Review',
    payNext1Title: 'Active Review', payNext1Body: 'Your application is now in active review. Decisions are typically made within 24 to 72 hours, and applicants who respond promptly to any follow-up are often prioritized.',
    payNext2Title: 'Background & Income Verification', payNext2Body: 'We will conduct standard verification procedures as part of our review.',
    payNext3Title: 'Decision Notification', payNext3Body: 'You will receive an email once a decision has been made.',
    approvedSubject: '[Choice Properties] Application Approved \u2014 ',
    statusSubject: '[Choice Properties] Application Status Update \u2014 ',
    approvedTitle: 'Application Approved', statusTitle: 'Application Update',
    approvedStatus: '\u2713  Congratulations \u2014 Your Application Has Been Approved',
    deniedStatus: '\u2014  Your Application Has Been Reviewed',
    approvedIntro: 'We are delighted to inform you that your rental application with Choice Properties has been <strong>approved</strong>. Our leasing team will be in contact shortly to prepare and deliver your lease agreement for electronic signature.',
    approvedCalloutTitle: '\u2713 Application Approved',
    approvedCalloutBody: 'You have been selected based on your application. This selection is time-sensitive \u2014 units are offered on a first-completion basis among approved applicants. Please complete the next steps promptly to secure your unit.',
    approvedNextLabel: 'Your Next Steps',
    approvedNext1Title: 'Lease Agreement', approvedNext1Body: 'Your lease agreement will be prepared and sent to you shortly. Please review and sign promptly to maintain your reservation.',
    approvedNext2Title: 'Electronic Signature', approvedNext2Body: 'You will sign your lease electronically. Your signature is legally binding under applicable state and federal e-signature law.',
    approvedNext3Title: 'Move-In Costs', approvedNext3Body: 'Prior to receiving your keys, the move-in total must be paid in full as outlined in your lease.',
    approvedNext4Title: 'Key Handoff', approvedNext4Body: 'Once all documents and payments are complete, we will coordinate your move-in date.',
    deniedIntro: 'Thank you for the time and effort you invested in your rental application. After careful consideration, we regret to inform you that we are unable to offer tenancy at this time.',
    deniedCalloutTitle: 'Application Status \u2014 Not Approved',
    deniedCalloutBodyPre: 'After review, the primary reason relates to:',
    deniedCalloutBodyPost: 'We understand this is disappointing and we genuinely appreciate the trust you placed in us.',
    deniedCalloutBodyNone: 'We understand this is disappointing and we genuinely appreciate the trust you placed in us.',
    lookingAheadLabel: 'Looking Ahead',
    deniedNext1Title: 'Reapplication Protection Policy', deniedNext1Body: 'As a Choice Properties applicant, you may apply for any other available listing within <strong>30 days</strong> at no additional fee.',
    deniedNext2Title: 'Other Properties', deniedNext2Body: 'Our team manages a portfolio of properties nationwide and would be happy to discuss alternatives.',
    viewAppBtn: 'View My Application',
    leaseSentSubject: '[Choice Properties] Action Required \u2014 Lease Agreement Ready for Signature (',
    leaseSentTitle: 'Your Lease Agreement is Ready',
    leaseSentStatus: '\ud83d\udccb  Action Required \u2014 Please Review and Sign Within 48 Hours',
    leaseSentIntro: 'Your Residential Lease Agreement has been formally prepared and is now ready for your review and electronic signature. Please read the agreement in its entirety before signing. Your electronic signature constitutes a legally binding commitment under applicable state and federal law.',
    leaseSummaryLabel: 'Lease Summary', leasePropertyLabel: 'Property', leaseTermLabel2: 'Lease Term',
    leaseStartLabel: 'Lease Start Date', leaseEndLabel: 'Lease End Date',
    financialSummaryLabel: 'Financial Summary', moveInBreakdownTitle: 'Move-In Financial Breakdown',
    monthlyRentLabel: 'Monthly Rent', securityDepositLabel: 'Security Deposit', totalMoveInLabel: 'Total Due at Move-In',
    urgentTitle: '\u23f0 48-Hour Signing Window',
    urgentBody: 'To secure your unit, your lease must be signed within <strong>48 hours</strong>. If you require additional time, please contact our team immediately.',
    signLeaseBtn: 'Review & Sign My Lease', orCopyLink: 'Or copy this link:',
    leaseSignedSubject: '[Choice Properties] Lease Executed \u2014 Welcome, Tenant Confirmation (',
    leaseSignedTitle: 'Welcome to Choice Properties',
    leaseSignedStatus: '\u2713  Lease Successfully Executed \u2014 Your Tenancy is Confirmed',
    leaseSignedIntro: 'Congratulations and welcome to Choice Properties. Your Residential Lease Agreement has been successfully executed and is now legally in effect. This communication serves as your official confirmation of tenancy.',
    tenancyConfirmLabel: 'Your Tenancy Confirmation', tenancyConfirmTitle: '\u2713 Lease Executed \u2014 Tenancy Confirmed',
    moveInDateLabel: 'Move-In Date', leaseEndDateLabel: 'Lease End Date', monthlyRentLabel2: 'Monthly Rent',
    moveInTotalLabel: 'Move-In Total Due', appRefLabel: 'Application Reference',
    leaseSignedNextLabel: 'What Happens Next',
    leaseNext1Title: 'Move-In Payment', leaseNext1Body: 'Our leasing team will contact you to coordinate collection of your move-in total of',
    leaseNext2Title: 'Key Handoff', leaseNext2Body: 'Once all payments are confirmed, your key handoff will be coordinated.',
    leaseNext3Title: 'Your Dashboard', leaseNext3Body: 'View your lease details at any time through your applicant dashboard.',
    viewDashBtn: 'View My Dashboard', downloadLeaseBtn: '\ud83d\udcc4 Download Lease PDF',
    leaseWelcomeNote: 'We are truly delighted to welcome you to Choice Properties.',
    leaseCoSubject: '[Choice Properties] Action Required \u2014 Co-Applicant Lease Signature (',
    leaseCoTitle: 'Co-Applicant Lease Agreement Ready',
    leaseCoStatus: '\ud83d\udccb  Co-Applicant Action Required \u2014 Please Review and Sign',
    leaseCoIntro1: 'You have been listed as a co-applicant on a rental application submitted by',
    leaseCoIntro2: 'A Residential Lease Agreement has been prepared and requires your electronic co-signature before it is fully executed.',
    leaseCoLiability: 'As co-applicant, you are <strong>jointly and severally liable</strong> for all obligations under this lease, including monthly rent and security deposit.',
    leaseCoImportantTitle: '\u26a0\ufe0f Important \u2014 Use Only This Link',
    leaseCoImportantBody: 'Your co-applicant signing link is <strong>unique to you</strong>. Do not share it. The primary applicant has a separate link. You must use the button below to sign.',
    signCoBtn: 'Review & Sign as Co-Applicant',
    moveInSubject: '[Choice Properties] Welcome Home! Move-in Confirmed \u2014 ',
    moveInHeadline: 'Welcome Home,', moveInSubheadline: 'Your move-in has been officially confirmed',
    moveInCongrats: 'Congratulations on your new home!',
    moveInIntro: 'Your move-in for', moveInIntro2: 'has been confirmed by our leasing team.',
    moveInPropertyLabel: 'Property', moveInDateLabel2: 'Move-in Date', moveInRentLabel: 'Monthly Rent',
    moveInAppIdLabel: 'Application ID', moveInNotesLabel: 'Notes',
    moveInDueNote: "Your rent is due on the <strong>1st of each month</strong>. If you have any questions, don't hesitate to reach out to our team.",
    moveInDashBtn: 'View My Tenant Dashboard',
    adminMsgSubject: '[Choice Properties] Message from Your Leasing Team \u2014 ',
    adminMsgTitle: 'Message from Your Leasing Team',
    adminMsgIntro: 'Your leasing team has sent you a message regarding your application',
    adminMsgLabel: 'Message', replyBtn: 'Reply on My Dashboard',
    inquiryReplySubject: '[Choice Properties] We Received Your Inquiry \u2014 ',
    inquiryReplyTitle: 'Inquiry Received',
    inquiryReplyIntro1: 'Thank you for your inquiry regarding',
    inquiryReplyIntro2: 'We have received your message and a member of our leasing team will be in touch with you shortly to provide more information and schedule a showing if applicable.',
    inquiryDetailsTitle: 'Your Inquiry Details',
    inquiryClosingNote: 'We look forward to speaking with you.',
    appIdRecoverySubject: '[Choice Properties] Your Application ID \u2014 ',
    appIdRecoveryTitle: 'Application ID Recovery',
    appIdRecoveryIntro: 'You requested your Application ID. Here it is:',
    appIdRecoveryIgnore: 'If you did not request this, you can safely ignore this email.',
    footerMarketplace: 'Nationwide Marketplace', footerEqualHousing: 'Equal Housing Opportunity', footerRights: 'All rights reserved.',
  },
  es: {
    dear: 'Estimado/a', hello: 'Hola', questions: '\u00bfPreguntas?', textUs: 'Texto:',
    closingTeam: 'Equipo de Arrendamiento de Choice Properties',
    closingSystem: 'Sistema de Choice Properties',
    headerSub: 'Administraci\u00f3n Profesional de Propiedades',
    tagline: 'Su confianza es nuestro est\u00e1ndar.',
    confidential: 'Este mensaje est\u00e1 destinado exclusivamente al destinatario indicado y contiene informaci\u00f3n confidencial. Si lo recibi\u00f3 por error, por favor ign\u00f3relo y el\u00edminelo. Igualdad de Oportunidades en Vivienda.',
    appConfirmSubject: '[Choice Properties] Confirmaci\u00f3n Oficial de Solicitud \u2014 Ref: ',
    appConfirmTitle: 'Solicitud Recibida Exitosamente',
    appConfirmStatusPending: '\u23f3  En Espera del Pago \u00b7 Revisi\u00f3n Pendiente',
    appConfirmStatusFree: '\u2713  Solicitud Recibida \u2014 Sin Cargo Requerido \u00b7 Revisi\u00f3n Pendiente',
    appConfirmIntro: 'Gracias por elegir Choice Properties. Hemos recibido oficialmente su solicitud de arrendamiento y su expediente ha sido registrado de forma segura en nuestro sistema. Este correo constituye su acuse de recibo formal. Por favor cons\u00e9rvelo para sus registros.',
    appSummaryLabel: 'Resumen de Solicitud', appIdLabel: 'ID de Solicitud',
    applicantNameLabel: 'Nombre del Solicitante', propertyInterestLabel: 'Propiedad de Inter\u00e9s',
    toBeConfirmed: 'Por confirmar', requestedMoveInLabel: 'Fecha de Entrada Solicitada',
    notSpecified: 'No especificado', leaseTermLabel: 'Plazo del Contrato',
    appFeeLabel: 'Cargo de Solicitud', emailOnFileLabel: 'Correo Registrado',
    phoneOnFileLabel: 'Tel\u00e9fono Registrado', freeNoFee: 'Gratis \u2014 Sin cargo de solicitud',
    paymentMethodsLabel: 'Sus M\u00e9todos de Pago Seleccionados',
    payFeeTitle: 'Cargo de Solicitud',
    payFeeIntro: 'Usted ha indicado los siguientes m\u00e9todos de pago preferidos. Nuestro equipo se comunicar\u00e1 con usted dentro de las 24 horas para coordinar el cobro del cargo de solicitud.',
    noFeeTitle: '\u2713 Sin Cargo de Solicitud',
    noFeeDesc: 'Esta propiedad no tiene cargo de solicitud. Su solicitud ha sido recibida y proceder\u00e1 directamente a revisi\u00f3n.',
    whatHappensNext: 'Pr\u00f3ximos Pasos',
    nextFee1Title: 'Arreglo de Pago',
    nextFee1Body: 'Un miembro de nuestro equipo de arrendamiento se comunicar\u00e1 con usted dentro de las 24 horas por mensaje de texto al',
    nextFee1Body2: 'para coordinar su cargo de solicitud de',
    nextFee2Title: 'Confirmaci\u00f3n de Pago',
    nextFee2Body: 'Una vez recibido su pago, recibir\u00e1 una notificaci\u00f3n por correo y su solicitud avanzar\u00e1 a revisi\u00f3n.',
    nextFee3Title: 'Revisi\u00f3n de Solicitud',
    nextFee3Body: 'Las solicitudes generalmente se procesan dentro de 24 a 72 horas despu\u00e9s de completar el pago. Los solicitantes que completan los pasos con prontitud suelen tener prioridad en la cola de revisi\u00f3n.',
    nextFee4Title: 'Notificaci\u00f3n de Decisi\u00f3n',
    nextFee4Body: 'Se le notificar\u00e1 nuestra decisi\u00f3n por correo. Si es aprobado/a, nuestro equipo preparar\u00e1 su contrato de arrendamiento para firma.',
    nextFree1Title: 'Revisi\u00f3n de Solicitud',
    nextFree1Body: 'Las solicitudes generalmente se procesan dentro de 24 a 72 horas de recibidas. Los solicitantes que responden con prontitud a cualquier seguimiento suelen tener prioridad.',
    nextFree2Title: 'Notificaci\u00f3n de Decisi\u00f3n',
    nextFree2Body: 'Se le notificar\u00e1 nuestra decisi\u00f3n por correo una vez tomada la determinaci\u00f3n.',
    nextFree3Title: 'Si es Aprobado/a',
    nextFree3Body: 'Nuestro equipo preparar\u00e1 su contrato de arrendamiento para firma electr\u00f3nica y le guiar\u00e1 en los pr\u00f3ximos pasos.',
    saveAppIdTitle: 'Importante \u2014 Guarde su ID de Solicitud',
    saveAppIdBody: 'Su ID de solicitud es', saveAppIdBody2: 'Guarde este n\u00famero de referencia para rastrear el estado de su solicitud en cualquier momento.',
    trackBtn: 'Rastrear Mi Solicitud', orVisit: 'O visite:',
    closingNote: 'Si tiene alguna pregunta antes de recibir noticias de nuestro equipo, no dude en comunicarse con nosotros.',
    payConfirmSubject: '[Choice Properties] Pago de Solicitud Confirmado \u2014 ',
    payConfirmTitle: 'Pago de Solicitud Confirmado',
    payConfirmStatus: '\u2713  Pago Recibido \u2014 Solicitud Ahora en Revisi\u00f3n',
    payConfirmIntro: 'Nos complace confirmar que su cargo de procesamiento de solicitud ha sido recibido y registrado oficialmente. Su solicitud est\u00e1 activa y ha sido colocada en nuestra cola de revisi\u00f3n formal.',
    payConfirmSectionLabel: 'Confirmaci\u00f3n de Pago', payConfirmSuccess: '\u2713 Pago Recibido Exitosamente',
    payConfirmAppId: 'ID de Solicitud', payConfirmApplicant: 'Solicitante',
    payConfirmDate: 'Fecha de Pago', payConfirmStatus2: 'Estado', underReview: 'En Revisi\u00f3n Activa',
    payNext1Title: 'Revisi\u00f3n Activa', payNext1Body: 'Su solicitud est\u00e1 ahora en revisi\u00f3n activa. Las decisiones generalmente se toman dentro de 24 a 72 horas, y los solicitantes que responden con prontitud a cualquier seguimiento suelen tener prioridad.',
    payNext2Title: 'Verificaci\u00f3n de Antecedentes e Ingresos', payNext2Body: 'Realizaremos los procedimientos est\u00e1ndar de verificaci\u00f3n como parte de nuestra revisi\u00f3n.',
    payNext3Title: 'Notificaci\u00f3n de Decisi\u00f3n', payNext3Body: 'Recibir\u00e1 un correo electr\u00f3nico una vez que se haya tomado una decisi\u00f3n.',
    approvedSubject: '[Choice Properties] Solicitud Aprobada \u2014 ',
    statusSubject: '[Choice Properties] Actualizaci\u00f3n de Estado de Solicitud \u2014 ',
    approvedTitle: 'Solicitud Aprobada', statusTitle: 'Actualizaci\u00f3n de Solicitud',
    approvedStatus: '\u2713  Felicitaciones \u2014 Su Solicitud Ha Sido Aprobada',
    deniedStatus: '\u2014  Su Solicitud Ha Sido Revisada',
    approvedIntro: 'Nos complace informarle que su solicitud de arrendamiento con Choice Properties ha sido <strong>aprobada</strong>. Nuestro equipo se comunicar\u00e1 con usted en breve para preparar y enviarle su contrato de arrendamiento para firma electr\u00f3nica.',
    approvedCalloutTitle: '\u2713 Solicitud Aprobada',
    approvedCalloutBody: 'Ha sido seleccionado/a seg\u00fan su solicitud. Esta selecci\u00f3n es sensible al tiempo \u2014 las unidades se ofrecen por orden de finalizaci\u00f3n entre los solicitantes aprobados. Por favor complete los siguientes pasos con prontitud para asegurar su unidad.',
    approvedNextLabel: 'Sus Pr\u00f3ximos Pasos',
    approvedNext1Title: 'Contrato de Arrendamiento', approvedNext1Body: 'Su contrato de arrendamiento se preparar\u00e1 y enviar\u00e1 en breve. Por favor rev\u00edselo y f\u00edrmelo con prontitud para mantener su reserva.',
    approvedNext2Title: 'Firma Electr\u00f3nica', approvedNext2Body: 'Firmar\u00e1 su contrato electr\u00f3nicamente. Su firma es legalmente vinculante bajo las leyes estatales y federales aplicables.',
    approvedNext3Title: 'Costos de Entrada', approvedNext3Body: 'Antes de recibir sus llaves, el total de entrada debe pagarse en su totalidad seg\u00fan lo estipulado en su contrato.',
    approvedNext4Title: 'Entrega de Llaves', approvedNext4Body: 'Una vez completados todos los documentos y pagos, coordinaremos su fecha de entrada.',
    deniedIntro: 'Gracias por el tiempo y esfuerzo que dedic\u00f3 a su solicitud de arrendamiento. Tras una cuidadosa consideraci\u00f3n, lamentamos informarle que no podemos ofrecerle arrendamiento en este momento.',
    deniedCalloutTitle: 'Estado de Solicitud \u2014 No Aprobada',
    deniedCalloutBodyPre: 'Tras la revisi\u00f3n, la raz\u00f3n principal se relaciona con:',
    deniedCalloutBodyPost: 'Entendemos que esto es decepcionante y apreciamos sinceramente la confianza que deposit\u00f3 en nosotros.',
    deniedCalloutBodyNone: 'Entendemos que esto es decepcionante y apreciamos sinceramente la confianza que deposit\u00f3 en nosotros.',
    lookingAheadLabel: 'Mirando Hacia Adelante',
    deniedNext1Title: 'Pol\u00edtica de Protecci\u00f3n de Nueva Solicitud', deniedNext1Body: 'Como solicitante de Choice Properties, puede aplicar para cualquier otro inmueble disponible dentro de <strong>30 d\u00edas</strong> sin cargo adicional.',
    deniedNext2Title: 'Otras Propiedades', deniedNext2Body: 'Nuestro equipo administra un portafolio de propiedades a nivel nacional y con gusto discutir\u00e1 alternativas.',
    viewAppBtn: 'Ver Mi Solicitud',
    leaseSentSubject: '[Choice Properties] Acci\u00f3n Requerida \u2014 Contrato Listo para Firma (',
    leaseSentTitle: 'Su Contrato de Arrendamiento Est\u00e1 Listo',
    leaseSentStatus: '\ud83d\udccb  Acci\u00f3n Requerida \u2014 Por Favor Revise y Firme en 48 Horas',
    leaseSentIntro: 'Su Contrato de Arrendamiento Residencial ha sido formalmente preparado y est\u00e1 listo para su revisi\u00f3n y firma electr\u00f3nica. Por favor lea el contrato en su totalidad antes de firmar. Su firma electr\u00f3nica constituye un compromiso legalmente vinculante bajo las leyes estatales y federales aplicables.',
    leaseSummaryLabel: 'Resumen del Contrato', leasePropertyLabel: 'Propiedad', leaseTermLabel2: 'Plazo del Contrato',
    leaseStartLabel: 'Fecha de Inicio', leaseEndLabel: 'Fecha de T\u00e9rmino',
    financialSummaryLabel: 'Resumen Financiero', moveInBreakdownTitle: 'Desglose Financiero de Entrada',
    monthlyRentLabel: 'Renta Mensual', securityDepositLabel: 'Dep\u00f3sito de Seguridad', totalMoveInLabel: 'Total a Pagar al Ingresar',
    urgentTitle: '\u23f0 Plazo de 48 Horas para Firmar',
    urgentBody: 'Para asegurar su unidad, el contrato debe firmarse dentro de <strong>48 horas</strong>. Si necesita tiempo adicional, comun\u00edquese con nuestro equipo de inmediato.',
    signLeaseBtn: 'Revisar y Firmar Mi Contrato', orCopyLink: 'O copie este enlace:',
    leaseSignedSubject: '[Choice Properties] Contrato Ejecutado \u2014 Confirmaci\u00f3n de Arrendatario (',
    leaseSignedTitle: 'Bienvenido/a a Choice Properties',
    leaseSignedStatus: '\u2713  Contrato Ejecutado Exitosamente \u2014 Su Arrendamiento Est\u00e1 Confirmado',
    leaseSignedIntro: 'Felicitaciones y bienvenido/a a Choice Properties. Su Contrato de Arrendamiento Residencial ha sido ejecutado exitosamente y tiene vigencia legal. Esta comunicaci\u00f3n sirve como confirmaci\u00f3n oficial de su arrendamiento.',
    tenancyConfirmLabel: 'Confirmaci\u00f3n de Su Arrendamiento', tenancyConfirmTitle: '\u2713 Contrato Ejecutado \u2014 Arrendamiento Confirmado',
    moveInDateLabel: 'Fecha de Entrada', leaseEndDateLabel: 'Fecha de T\u00e9rmino del Contrato', monthlyRentLabel2: 'Renta Mensual',
    moveInTotalLabel: 'Total a Pagar al Ingresar', appRefLabel: 'Referencia de Solicitud',
    leaseSignedNextLabel: 'Pr\u00f3ximos Pasos',
    leaseNext1Title: 'Pago de Entrada', leaseNext1Body: 'Nuestro equipo de arrendamiento se comunicar\u00e1 con usted para coordinar el cobro de su total de entrada de',
    leaseNext2Title: 'Entrega de Llaves', leaseNext2Body: 'Una vez confirmados todos los pagos, se coordinar\u00e1 la entrega de llaves.',
    leaseNext3Title: 'Su Panel de Control', leaseNext3Body: 'Consulte los detalles de su contrato en cualquier momento desde su panel de solicitante.',
    viewDashBtn: 'Ver Mi Panel de Control', downloadLeaseBtn: '\ud83d\udcc4 Descargar Contrato PDF',
    leaseWelcomeNote: 'Estamos verdaderamente encantados de darle la bienvenida a Choice Properties.',
    leaseCoSubject: '[Choice Properties] Acci\u00f3n Requerida \u2014 Firma de Co-Solicitante (',
    leaseCoTitle: 'Contrato de Arrendamiento Listo para Co-Solicitante',
    leaseCoStatus: '\ud83d\udccb  Acci\u00f3n Requerida del Co-Solicitante \u2014 Por Favor Revise y Firme',
    leaseCoIntro1: 'Usted ha sido registrado/a como co-solicitante en una solicitud de arrendamiento presentada por',
    leaseCoIntro2: 'Se ha preparado un Contrato de Arrendamiento Residencial que requiere su co-firma electr\u00f3nica antes de ser ejecutado.',
    leaseCoLiability: 'Como co-solicitante, usted es <strong>conjunta y solidariamente responsable</strong> de todas las obligaciones de este contrato, incluyendo la renta mensual y el dep\u00f3sito de seguridad.',
    leaseCoImportantTitle: '\u26a0\ufe0f Importante \u2014 Use \u00fanicamente Este Enlace',
    leaseCoImportantBody: 'Su enlace de firma como co-solicitante es <strong>\u00fanico para usted</strong>. No lo comparta. El solicitante principal tiene un enlace separado. Debe usar el bot\u00f3n a continuaci\u00f3n para firmar.',
    signCoBtn: 'Revisar y Firmar como Co-Solicitante',
    moveInSubject: '[Choice Properties] \u00a1Bienvenido/a a Casa! Entrada Confirmada \u2014 ',
    moveInHeadline: '\u00a1Bienvenido/a a Casa,', moveInSubheadline: 'Su entrada ha sido confirmada oficialmente',
    moveInCongrats: '\u00a1Felicitaciones por su nuevo hogar!',
    moveInIntro: 'Su entrada para', moveInIntro2: 'ha sido confirmada por nuestro equipo de arrendamiento.',
    moveInPropertyLabel: 'Propiedad', moveInDateLabel2: 'Fecha de Entrada', moveInRentLabel: 'Renta Mensual',
    moveInAppIdLabel: 'ID de Solicitud', moveInNotesLabel: 'Notas',
    moveInDueNote: 'Su renta vence el <strong>d\u00eda 1 de cada mes</strong>. Si tiene alguna pregunta, no dude en comunicarse con nuestro equipo.',
    moveInDashBtn: 'Ver Mi Panel de Arrendatario',
    adminMsgSubject: '[Choice Properties] Mensaje de Su Equipo de Arrendamiento \u2014 ',
    adminMsgTitle: 'Mensaje de Su Equipo de Arrendamiento',
    adminMsgIntro: 'Su equipo de arrendamiento le ha enviado un mensaje relacionado con su solicitud',
    adminMsgLabel: 'Mensaje', replyBtn: 'Responder en Mi Panel',
    inquiryReplySubject: '[Choice Properties] Recibimos Su Consulta \u2014 ',
    inquiryReplyTitle: 'Consulta Recibida',
    inquiryReplyIntro1: 'Gracias por su consulta sobre',
    inquiryReplyIntro2: 'Hemos recibido su mensaje y un miembro de nuestro equipo de arrendamiento se comunicar\u00e1 con usted en breve para brindarle m\u00e1s informaci\u00f3n y programar una visita si aplica.',
    inquiryDetailsTitle: 'Detalles de Su Consulta',
    inquiryClosingNote: 'Esperamos con gusto hablar con usted.',
    appIdRecoverySubject: '[Choice Properties] Su ID de Solicitud \u2014 ',
    appIdRecoveryTitle: 'Recuperaci\u00f3n de ID de Solicitud',
    appIdRecoveryIntro: 'Usted solicit\u00f3 su ID de Solicitud. Aqu\u00ed est\u00e1:',
    appIdRecoveryIgnore: 'Si no realiz\u00f3 esta solicitud, puede ignorar este correo con seguridad.',
    footerMarketplace: 'Mercado Nacional', footerEqualHousing: 'Igualdad de Oportunidades en Vivienda', footerRights: 'Todos los derechos reservados.',
  }
};

// ── HTML escape helper ──────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Translation helper ─────────────────────────────────────
function t(key, lang) {
  var l = (lang === 'es') ? 'es' : 'en';
  return (EMAIL_STRINGS[l] && EMAIL_STRINGS[l][key] !== undefined)
    ? EMAIL_STRINGS[l][key]
    : (EMAIL_STRINGS['en'][key] || key);
}

// ── Locale & formatting helpers ────────────────────────────
function userLocale(lang) { return lang === 'es' ? 'es-MX' : 'en-US'; }
function fmtCurrency(amount, lang) {
  return parseFloat(amount || 0).toLocaleString(userLocale(lang), { minimumFractionDigits: 2 });
}
function fmtDatetime(lang) {
  return new Date().toLocaleDateString(userLocale(lang), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Entry point ───────────────────────────────────────────
//
// M-3 hardening (2026-04-26):
//   The previous auth check relied on a single static `RELAY_SECRET`
//   submitted in the request body. If the secret leaked anywhere
//   (logs, network capture, GitHub Actions output, etc.) the relay
//   became an open Gmail spam endpoint with no way to revoke without
//   a coordinated rotation across edge functions + Apps Script.
//
// Issue #24 (2026-04-26):
//   The legacy `secret`-only acceptance path was removed once every
//   caller (send-inquiry, send-message, sendEmail) routed through the
//   shared `gasSend()` helper that always HMAC-signs. Only signed
//   mode is now accepted:
//     `ts` (Unix-seconds) and `sig` where
//     `sig = HMAC-SHA256(RELAY_SECRET, ts + "." + rawBody)` hex-encoded,
//     and `|now - ts| <= 5 minutes`. A leaked HMAC is only valid for
//     ±5 min, so the blast radius of a leak drops from "forever" to
//     "minutes".
//
//   Every call also runs through `constantTimeEquals` so we don't
//   leak validity through string-comparison timing.
// ───────────────────────────────────────────────────────────
var SIG_WINDOW_SECONDS = 5 * 60;

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hmacSha256Hex(secret, message) {
  var bytes = Utilities.computeHmacSha256Signature(message, secret);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

// E-4 (2026-04-28): ASCII-only JSON.stringify. Apps Script V8 and Deno V8
// disagree on UTF-8 round-tripping inside e.postData.contents, which broke
// the HMAC any time the payload contained a non-ASCII character (em-dash,
// ✓, ✅, etc.). Escaping every non-ASCII codepoint to \uXXXX keeps the
// canonical bytes identical on both runtimes. The matching helper exists
// in supabase/functions/_shared/send-email.ts — both must escape identically.
function jsonAscii(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, function(c) {
    var hex = c.charCodeAt(0).toString(16);
    return '\\u' + ('0000' + hex).slice(-4);
  });
}

function authorizeRequest(rawBody, body, e, cfg) {
  if (!cfg.secret) return { ok: false, error: 'Relay not configured' };

  var nowSec = Math.floor(Date.now() / 1000);

  // E-5 (2026-04-28): preferred scheme — sig in URL query, signed over
  // the raw request body bytes. This avoids the entire JSON-canonicalisation
  // round-trip (jsonAscii / parse+stringify) that the old in-body scheme
  // needed, and is therefore encoding-agnostic. Apps Script V8 and Deno V8
  // disagreed on UTF-8 round-tripping inside e.postData.contents, which is
  // what broke every admin email containing em-dashes / ✓ / ✅.
  //
  // Wire format (from supabase/functions/_shared/send-email.ts):
  //   POST {GAS_EMAIL_URL}?ts=<unix>&sig=<hex>
  //   body: JSON.stringify({ ts, template, to, cc, data })
  //   sig = HMAC-SHA256(RELAY_SECRET, ts + '.' + bodyText)  (lowercase hex)
  var qts  = e && e.parameter ? e.parameter.ts  : null;
  var qsig = e && e.parameter ? e.parameter.sig : null;
  if (qts && qsig) {
    var tsU = Number(qts);
    if (!isFinite(tsU) || tsU <= 0) return { ok: false, error: 'Invalid timestamp' };
    if (Math.abs(nowSec - tsU) > SIG_WINDOW_SECONDS) {
      return { ok: false, error: 'Timestamp outside ±5 min window' };
    }
    var expectedUrlSig = hmacSha256Hex(cfg.secret, tsU + '.' + (rawBody || ''));
    if (constantTimeEquals(String(qsig).toLowerCase(), expectedUrlSig)) {
      return { ok: true, mode: 'signed-url' };
    }
    return { ok: false, error: 'Bad signature' };
  }

  // Legacy in-body sig path. Kept so an old Supabase deploy still works
  // while the new code rolls out. Safe to remove once the URL scheme has
  // been live for a release cycle.
  if (!body || body.ts == null || !body.sig) {
    return { ok: false, error: 'Unauthorized: signed mode required (ts + sig)' };
  }
  var ts = Number(body.ts);
  if (!isFinite(ts) || ts <= 0) return { ok: false, error: 'Invalid timestamp' };
  if (Math.abs(nowSec - ts) > SIG_WINDOW_SECONDS) {
    return { ok: false, error: 'Timestamp outside ±5 min window' };
  }
  var bodyNoSig = {};
  for (var k in body) { if (body.hasOwnProperty(k) && k !== 'sig') bodyNoSig[k] = body[k]; }
  var sigLower  = String(body.sig).toLowerCase();
  var canonicalA = jsonAscii(bodyNoSig);
  var expectedA  = hmacSha256Hex(cfg.secret, ts + '.' + canonicalA);
  if (constantTimeEquals(sigLower, expectedA)) return { ok: true, mode: 'signed' };
  var canonicalU = JSON.stringify(bodyNoSig);
  var expectedU  = hmacSha256Hex(cfg.secret, ts + '.' + canonicalU);
  if (constantTimeEquals(sigLower, expectedU)) return { ok: true, mode: 'signed-legacy' };
  return { ok: false, error: 'Bad signature' };
}

function doPost(e) {
  var cfg = getConfig();
  var respond = function(data) {
    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
  };
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    var body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_jp) { body = null; }
    var auth = authorizeRequest(raw, body, e, cfg);
    if (!auth.ok) return respond({ success: false, error: auth.error });
    if (!body) return respond({ success: false, error: 'Body must be valid JSON' });

    var template = body.template, to = body.to, cc = body.cc, data = body.data;
    if (!template || !to) return respond({ success: false, error: 'Missing template or to field' });
    return respond(dispatch(template, to, cc, data, cfg));
  } catch(err) {
    console.error('GAS relay error:', err);
    return respond({ success: false, error: err.toString() });
  }
}

function doGet() {
  return ContentService.createTextOutput('Not found').setMimeType(ContentService.MimeType.TEXT);
}

// ── Dispatcher ────────────────────────────────────────────
function dispatch(template, to, cc, data, cfg) {
  var senders = {
    'application_confirmation': sendApplicationConfirmation,
    'admin_notification':       sendAdminNotification,
    'payment_confirmation':     sendPaymentConfirmation,
    'status_update':            sendStatusUpdate,
    'lease_sent':               sendLeaseSent,
    'lease_sent_co_applicant':  sendLeaseSentCoApplicant,
    'lease_signed_tenant':      sendLeaseSignedTenant,
    'lease_signed_admin':       sendLeaseSignedAdmin,
    'move_in_confirmation':     sendMoveInConfirmation,
    'admin_message':            sendAdminMessage,
    'inquiry_reply':            sendInquiryReply,
    'new_inquiry':              sendNewInquiry,
    'landlord_notification':    sendLandlordNotification,
    'app_id_recovery':          sendAppIdRecovery,
    'co_applicant_notification': sendCoApplicantNotification,
    'new_message_landlord':     sendNewMessageLandlord,
    'new_message_tenant':       sendNewMessageTenant,
    'new_application':          sendNewApplication,
    'raw_html':                 sendRawHtml,
  };
  var fn = senders[template];
  if (!fn) return { success: false, error: 'Unknown template: ' + template };
  try { fn(to, cc, data, cfg); return { success: true, template: template, to: to }; }
  catch(err) { console.error('Email error [' + template + ']:', err); return { success: false, error: err.toString() }; }
}

// ── Send helper ───────────────────────────────────────────
function send(to, cc, subject, htmlBody, cfg) {
  var opts = { to: Array.isArray(to) ? to.join(',') : to, subject: subject, htmlBody: htmlBody, name: cfg.companyName + ' Leasing', replyTo: cfg.companyEmail };
  if (cc && cc.length) opts.cc = Array.isArray(cc) ? cc.join(',') : cc;
  MailApp.sendEmail(opts);
}

function sendRawHtml(to, cc, d, cfg) {
  send(to, cc, d.subject || 'Choice Properties', d.html || '', cfg);
}

// ============================================================
// TEMPLATES
// ============================================================

// ── 1. Application Confirmation (bilingual) ───────────────
function sendApplicationConfirmation(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  var payMethods = buildPaymentMethodList(d);
  var fee = parseFloat(d.application_fee) || 0;
  var hasFee = fee > 0;
  var feeLabel = hasFee ? '$' + fmtCurrency(fee, lang) : t('freeNoFee', lang);
  var statusBanner = hasFee
    ? '<div class="status-line status-pending">' + t('appConfirmStatusPending', lang) + '</div>'
    : '<div class="status-line" style="color:#166534;background:#f0fdf4">' + t('appConfirmStatusFree', lang) + '</div>';
  var paymentSection = hasFee
    ? '<div class="section"><div class="section-label">' + t('paymentMethodsLabel', lang) + '</div><div class="callout amber"><h4>' + t('payFeeTitle', lang) + ' \u2014 ' + feeLabel + '</h4><p style="margin-bottom:12px;">' + t('payFeeIntro', lang) + '</p><div>' + payMethods.map(function(m){ return '<span class="pay-pill">' + m + '</span>'; }).join('') + '</div></div></div>'
    : '<div class="section"><div class="callout green"><h4>' + t('noFeeTitle', lang) + '</h4><p>' + t('noFeeDesc', lang) + '</p></div></div>';
  var nextSteps = hasFee
    ? '<ul class="steps-list"><li><span class="step-num">1</span><span><strong>' + t('nextFee1Title', lang) + '</strong> \u2014 ' + t('nextFee1Body', lang) + ' <strong>' + esc(d.phone) + '</strong> ' + t('nextFee1Body2', lang) + ' <strong>' + feeLabel + '</strong>.</span></li><li><span class="step-num">2</span><span><strong>' + t('nextFee2Title', lang) + '</strong> \u2014 ' + t('nextFee2Body', lang) + '</span></li><li><span class="step-num">3</span><span><strong>' + t('nextFee3Title', lang) + '</strong> \u2014 ' + t('nextFee3Body', lang) + '</span></li><li><span class="step-num">4</span><span><strong>' + t('nextFee4Title', lang) + '</strong> \u2014 ' + t('nextFee4Body', lang) + '</span></li></ul>'
    : '<ul class="steps-list"><li><span class="step-num">1</span><span><strong>' + t('nextFree1Title', lang) + '</strong> \u2014 ' + t('nextFree1Body', lang) + '</span></li><li><span class="step-num">2</span><span><strong>' + t('nextFree2Title', lang) + '</strong> \u2014 ' + t('nextFree2Body', lang) + '</span></li><li><span class="step-num">3</span><span><strong>' + t('nextFree3Title', lang) + '</strong> \u2014 ' + t('nextFree3Body', lang) + '</span></li></ul>';
  send(to, cc, t('appConfirmSubject', lang) + d.app_id,
    wrap(t('appConfirmTitle', lang), d.app_id, lang,
      statusBanner + '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.first_name) + ',</p><p class="intro-text">' + t('appConfirmIntro', lang) + '</p>' +
      '<div class="section"><div class="section-label">' + t('appSummaryLabel', lang) + '</div><table class="info-table">' +
      '<tr><td>' + t('appIdLabel', lang) + '</td><td><strong>' + d.app_id + '</strong></td></tr>' +
      '<tr><td>' + t('applicantNameLabel', lang) + '</td><td>' + esc(d.first_name) + ' ' + esc(d.last_name) + '</td></tr>' +
      '<tr><td>' + t('propertyInterestLabel', lang) + '</td><td>' + esc(d.property_address || t('toBeConfirmed', lang)) + '</td></tr>' +
      '<tr><td>' + t('requestedMoveInLabel', lang) + '</td><td>' + esc(d.requested_move_in_date || t('notSpecified', lang)) + '</td></tr>' +
      '<tr><td>' + t('leaseTermLabel', lang) + '</td><td>' + esc(d.desired_lease_term || t('notSpecified', lang)) + '</td></tr>' +
      '<tr><td>' + t('appFeeLabel', lang) + '</td><td>' + feeLabel + '</td></tr>' +
      '<tr><td>' + t('emailOnFileLabel', lang) + '</td><td>' + esc(d.email) + '</td></tr>' +
      '<tr><td>' + t('phoneOnFileLabel', lang) + '</td><td>' + esc(d.phone) + '</td></tr>' +
      '</table></div>' + paymentSection +
      '<div class="section"><div class="section-label">' + t('whatHappensNext', lang) + '</div>' + nextSteps + '</div>' +
      '<div class="callout"><h4>' + t('saveAppIdTitle', lang) + '</h4><p>' + t('saveAppIdBody', lang) + ' <strong>' + d.app_id + '</strong>. ' + t('saveAppIdBody2', lang) + '</p></div>' +
      '<div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">' + t('trackBtn', lang) + '</a><div class="cta-note">' + t('orVisit', lang) + ' ' + dashLink + '</div></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><p class="closing-text">' + t('closingNote', lang) + '</p><div class="sign-off">' + t('closingTeam', lang) + '</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 2. Admin Notification (English only — internal) ───────
function sendAdminNotification(to, cc, d, cfg) {
  var adminUrl = cfg.dashboardUrl + '/admin/applications.html';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  var payMethods = buildPaymentMethodList(d);
  var fee = parseFloat(d.application_fee) || 0;
  var hasFee = fee > 0;
  var feeLabel = hasFee ? '$' + fee.toLocaleString('en-US', {minimumFractionDigits:2}) : 'Free \u2014 No fee';
  var statusBanner = hasFee ? '<div class="status-line status-pending">\u26a1 &nbsp; Action Required \u2014 Fee Pending Collection</div>' : '<div class="status-line" style="color:#166534;background:#f0fdf4">\ud83d\udccb &nbsp; New Application \u2014 No Fee \u2014 Proceed to Review</div>';
  var paymentBlock = hasFee ? '<div class="section"><div class="section-label">Payment Preferences</div><div class="callout amber"><h4>Contact Applicant to Collect Fee \u2014 ' + feeLabel + '</h4><p style="margin-bottom:12px;">Preferred payment methods:</p><div>' + payMethods.map(function(m){ return '<span class="pay-pill">' + m + '</span>'; }).join('') + '</div></div></div>' : '<div class="section"><div class="callout green"><h4>\u2713 No Application Fee</h4><p>No payment collection required \u2014 proceed to review.</p></div></div>';
  send(cfg.adminEmails, null,
    '[New Application] ' + d.app_id + ' \u2014 ' + d.first_name + ' ' + d.last_name + (hasFee ? ' \u2014 Fee Pending' : ' \u2014 No Fee \u2014 Proceed to Review'),
    wrap('New Application Received', d.app_id, 'en',
      statusBanner + '<div class="email-body"><p class="greeting">New Application Alert,</p><p class="intro-text">' + (hasFee ? 'A new rental application has been received. Contact applicant within 24 hours to arrange the fee.' : 'A new rental application has been received. No fee required \u2014 proceed to review.') + '</p>' +
      '<div class="section"><div class="section-label">Applicant Overview</div><table class="info-table">' +
      '<tr><td>Full Name</td><td><strong>' + esc(d.first_name) + ' ' + esc(d.last_name) + '</strong></td></tr>' +
      '<tr><td>Email</td><td>' + esc(d.email) + '</td></tr>' +
      '<tr><td>Phone</td><td><strong>' + esc(d.phone) + '</strong> (Text preferred)</td></tr>' +
      '<tr><td>Property</td><td>' + esc(d.property_address || 'Not specified') + '</td></tr>' +
      '<tr><td>Move-In</td><td>' + esc(d.requested_move_in_date || 'Not specified') + '</td></tr>' +
      '<tr><td>Lease Term</td><td>' + esc(d.desired_lease_term || 'Not specified') + '</td></tr>' +
      '<tr><td>App Fee</td><td>' + feeLabel + '</td></tr>' +
      '<tr><td>Preferred Language</td><td>' + (d.preferred_language === 'es' ? 'Spanish / Espa\u00f1ol' : 'English') + '</td></tr>' +
      '<tr><td>Contact Pref.</td><td>' + esc(d.preferred_contact_method || 'Not specified') + '</td></tr>' +
      '<tr><td>Best Times</td><td>' + esc(d.preferred_time || 'Any') + '</td></tr>' +
      '</table></div>' + paymentBlock +
      '<div class="section"><div class="section-label">Employment &amp; Income</div><table class="info-table">' +
      '<tr><td>Status</td><td>' + esc(d.employment_status || 'Not specified') + '</td></tr>' +
      '<tr><td>Employer</td><td>' + esc(d.employer || 'N/A') + '</td></tr>' +
      '<tr><td>Monthly Income</td><td>' + (d.monthly_income ? '$' + parseFloat(d.monthly_income).toLocaleString() : 'Not specified') + '</td></tr>' +
      '</table></div>' +
      '<div class="section"><div class="section-label">Quick Actions</div><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">' +
      '<a href="' + adminUrl + '" style="display:inline-block;background:#0a1628;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Admin Dashboard</a>' +
      '<a href="' + dashLink + '" style="display:inline-block;background:#1d4ed8;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">View Application</a>' +
      '<a href="mailto:' + d.email + '?subject=Your%20Application%20' + d.app_id + '" style="display:inline-block;background:#64748b;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Email Applicant</a>' +
      '</div></div><div class="email-closing"><div class="sign-off">Choice Properties System</div><div class="sign-company">Automated Admin Notification \u2014 ' + d.app_id + '</div></div></div>', cfg), cfg);
}

// ── 3. Landlord Notification (English only — internal) ────
function sendLandlordNotification(to, cc, d, cfg) {
  var dashLink = cfg.dashboardUrl + '/landlord/applications.html';
  send(to, cc,
    '[Choice Properties] New Application for ' + (d.propertyAddress || d.property_address || 'your listing') + ' \u2014 ' + (d.applicantName || d.first_name + ' ' + d.last_name),
    wrap('New Rental Application', d.app_id, 'en',
      '<div class="status-line status-pending">\ud83d\udccb &nbsp; Someone applied to your property</div>' +
      '<div class="email-body"><p class="greeting">Hi ' + esc(d.landlordName || 'there') + ',</p><p class="intro-text">A new rental application has been submitted for <strong>' + esc(d.propertyAddress || d.property_address || 'your property') + '</strong>. Log in to your landlord dashboard to review.</p>' +
      '<div class="section"><div class="section-label">Applicant</div><table class="info-table">' +
      '<tr><td>Name</td><td><strong>' + esc(d.first_name) + ' ' + esc(d.last_name) + '</strong></td></tr>' +
      '<tr><td>Email</td><td>' + esc(d.email) + '</td></tr>' +
      '<tr><td>Phone</td><td>' + esc(d.phone) + '</td></tr>' +
      '<tr><td>Move-In</td><td>' + esc(d.requested_move_in_date || 'Not specified') + '</td></tr>' +
      '<tr><td>Lease Term</td><td>' + esc(d.desired_lease_term || 'Not specified') + '</td></tr>' +
      '<tr><td>App ID</td><td style="font-family:monospace">' + d.app_id + '</td></tr>' +
      '</table></div>' +
      '<div class="section"><a href="' + dashLink + '" style="display:inline-block;background:#0a1628;color:white;text-decoration:none;padding:12px 24px;border-radius:3px;font-size:14px;font-weight:600;">View in Landlord Dashboard \u2192</a></div>' +
      '<div class="contact-row"><strong>Questions?</strong> &nbsp; Text: ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">Choice Properties</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 4. Payment Confirmation (bilingual) ───────────────────
function sendPaymentConfirmation(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  var firstName = (d.applicant_name || '').split(' ')[0];
  send(to, cc, t('payConfirmSubject', lang) + d.app_id,
    wrap(t('payConfirmTitle', lang), d.app_id, lang,
      '<div class="status-line status-paid">' + t('payConfirmStatus', lang) + '</div>' +
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(firstName) + ',</p><p class="intro-text">' + t('payConfirmIntro', lang) + '</p>' +
      '<div class="section"><div class="section-label">' + t('payConfirmSectionLabel', lang) + '</div><div class="callout green"><h4>' + t('payConfirmSuccess', lang) + '</h4>' +
      '<div class="financial-row"><span class="f-label">' + t('payConfirmAppId', lang) + '</span><span class="f-value">' + d.app_id + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('payConfirmApplicant', lang) + '</span><span class="f-value">' + esc(d.applicant_name) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('payConfirmDate', lang) + '</span><span class="f-value">' + fmtDatetime(lang) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('payConfirmStatus2', lang) + '</span><span class="f-value" style="color:#059669;">' + t('underReview', lang) + '</span></div>' +
      '</div></div><div class="section"><div class="section-label">' + t('whatHappensNext', lang) + '</div><ul class="steps-list">' +
      '<li><span class="step-num">1</span><span><strong>' + t('payNext1Title', lang) + '</strong> \u2014 ' + t('payNext1Body', lang) + '</span></li>' +
      '<li><span class="step-num">2</span><span><strong>' + t('payNext2Title', lang) + '</strong> \u2014 ' + t('payNext2Body', lang) + '</span></li>' +
      '<li><span class="step-num">3</span><span><strong>' + t('payNext3Title', lang) + '</strong> \u2014 ' + t('payNext3Body', lang) + '</span></li>' +
      '</ul></div><div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">' + t('trackBtn', lang) + '</a></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 5. Status Update (bilingual) ─────────────────────────
function sendStatusUpdate(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  var isApproved = d.status === 'approved';
  var body = isApproved
    ? '<p class="intro-text">' + t('approvedIntro', lang) + '</p><div class="callout green"><h4>' + t('approvedCalloutTitle', lang) + '</h4><p>' + t('approvedCalloutBody', lang) + '</p></div><div class="section"><div class="section-label">' + t('approvedNextLabel', lang) + '</div><ul class="steps-list"><li><span class="step-num">1</span><span><strong>' + t('approvedNext1Title', lang) + '</strong> \u2014 ' + t('approvedNext1Body', lang) + '</span></li><li><span class="step-num">2</span><span><strong>' + t('approvedNext2Title', lang) + '</strong> \u2014 ' + t('approvedNext2Body', lang) + '</span></li><li><span class="step-num">3</span><span><strong>' + t('approvedNext3Title', lang) + '</strong> \u2014 ' + t('approvedNext3Body', lang) + '</span></li><li><span class="step-num">4</span><span><strong>' + t('approvedNext4Title', lang) + '</strong> \u2014 ' + t('approvedNext4Body', lang) + '</span></li></ul></div>'
    : '<p class="intro-text">' + t('deniedIntro', lang) + '</p><div class="callout red"><h4>' + t('deniedCalloutTitle', lang) + '</h4><p>' + (d.reason ? t('deniedCalloutBodyPre', lang) + ' <strong>' + esc(d.reason) + '</strong>. ' + t('deniedCalloutBodyPost', lang) : t('deniedCalloutBodyNone', lang)) + '</p></div><div class="section"><div class="section-label">' + t('lookingAheadLabel', lang) + '</div><ul class="steps-list"><li><span class="step-num">1</span><span><strong>' + t('deniedNext1Title', lang) + '</strong> \u2014 ' + t('deniedNext1Body', lang) + '</span></li><li><span class="step-num">2</span><span><strong>' + t('deniedNext2Title', lang) + '</strong> \u2014 ' + t('deniedNext2Body', lang) + '</span></li></ul></div>';
  send(to, cc,
    (isApproved ? t('approvedSubject', lang) : t('statusSubject', lang)) + d.app_id,
    wrap(isApproved ? t('approvedTitle', lang) : t('statusTitle', lang), d.app_id, lang,
      '<div class="status-line ' + (isApproved ? 'status-approved' : 'status-denied') + '">' + (isApproved ? t('approvedStatus', lang) : t('deniedStatus', lang)) + '</div>' +
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.first_name) + ',</p>' + body +
      '<div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">' + t('viewAppBtn', lang) + '</a></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 6. Lease Sent (bilingual) ─────────────────────────────
function sendLeaseSent(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  send(to, cc, t('leaseSentSubject', lang) + d.app_id + ')',
    wrap(t('leaseSentTitle', lang), d.app_id, lang,
      '<div class="status-line status-lease">' + t('leaseSentStatus', lang) + '</div>' +
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc((d.tenant_name || '').split(' ')[0] || 'Tenant') + ',</p><p class="intro-text">' + t('leaseSentIntro', lang) + '</p>' +
      '<div class="section"><div class="section-label">' + t('leaseSummaryLabel', lang) + '</div><table class="info-table">' +
      '<tr><td>' + t('leasePropertyLabel', lang) + '</td><td><strong>' + esc(d.property) + '</strong></td></tr>' +
      '<tr><td>' + t('leaseTermLabel2', lang) + '</td><td>' + esc(d.term) + '</td></tr>' +
      '<tr><td>' + t('leaseStartLabel', lang) + '</td><td>' + esc(d.start_date) + '</td></tr>' +
      '<tr><td>' + t('leaseEndLabel', lang) + '</td><td>' + esc(d.end_date) + '</td></tr>' +
      '</table></div><div class="section"><div class="section-label">' + t('financialSummaryLabel', lang) + '</div><div class="callout"><h4>' + t('moveInBreakdownTitle', lang) + '</h4>' +
      '<div class="financial-row"><span class="f-label">' + t('monthlyRentLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.rent, lang) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('securityDepositLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.deposit, lang) + '</span></div>' +
      '<div class="financial-row total"><span class="f-label">' + t('totalMoveInLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.move_in_costs, lang) + '</span></div>' +
      '</div></div><div class="callout amber"><h4>' + t('urgentTitle', lang) + '</h4><p>' + t('urgentBody', lang) + '</p></div>' +
      '<div class="cta-wrap"><a href="' + d.lease_link + '" class="cta-btn">' + t('signLeaseBtn', lang) + '</a><div class="cta-note">' + t('orCopyLink', lang) + ' ' + d.lease_link + '</div></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 7. Lease Signed — Tenant (bilingual) ─────────────────
function sendLeaseSignedTenant(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  send(to, cc, t('leaseSignedSubject', lang) + d.app_id + ')',
    wrap(t('leaseSignedTitle', lang), d.app_id, lang,
      '<div class="status-line status-approved">' + t('leaseSignedStatus', lang) + '</div>' +
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.first_name) + ',</p><p class="intro-text">' + t('leaseSignedIntro', lang) + '</p>' +
      '<div class="section"><div class="section-label">' + t('tenancyConfirmLabel', lang) + '</div><div class="callout green"><h4>' + t('tenancyConfirmTitle', lang) + '</h4>' +
      '<div class="financial-row"><span class="f-label">' + t('leasePropertyLabel', lang) + '</span><span class="f-value">' + esc(d.property) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('moveInDateLabel', lang) + '</span><span class="f-value">' + esc(d.start_date) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('leaseEndDateLabel', lang) + '</span><span class="f-value">' + esc(d.end_date) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('monthlyRentLabel2', lang) + '</span><span class="f-value">$' + fmtCurrency(d.rent, lang) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('moveInTotalLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.move_in_costs, lang) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('appRefLabel', lang) + '</span><span class="f-value">' + d.app_id + '</span></div>' +
      '</div></div><div class="section"><div class="section-label">' + t('leaseSignedNextLabel', lang) + '</div><ul class="steps-list">' +
      '<li><span class="step-num">1</span><span><strong>' + t('leaseNext1Title', lang) + '</strong> \u2014 ' + t('leaseNext1Body', lang) + ' <strong>$' + fmtCurrency(d.move_in_costs, lang) + '</strong>.</span></li>' +
      '<li><span class="step-num">2</span><span><strong>' + t('leaseNext2Title', lang) + '</strong> \u2014 ' + t('leaseNext2Body', lang) + '</span></li>' +
      '<li><span class="step-num">3</span><span><strong>' + t('leaseNext3Title', lang) + '</strong> \u2014 ' + t('leaseNext3Body', lang) + '</span></li>' +
      '</ul></div><div class="cta-wrap" style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">' +
      '<a href="' + dashLink + '" class="cta-btn">' + t('viewDashBtn', lang) + '</a>' +
      (d.pdf_url ? '<a href="' + d.pdf_url + '" class="cta-btn" style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);">' + t('downloadLeaseBtn', lang) + '</a>' : '') +
      '</div><div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><p class="closing-text">' + t('leaseWelcomeNote', lang) + '</p><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 8. Lease Signed — Admin (English only — internal) ─────
function sendLeaseSignedAdmin(to, cc, d, cfg) {
  var adminUrl = cfg.dashboardUrl + '/admin/applications.html';
  send(cfg.adminEmails, null,
    '[Lease Executed] ' + d.app_id + ' \u2014 ' + d.tenant_name + ' \u2014 Collect Move-In Payment',
    wrap('Lease Signed \u2014 Action Required', d.app_id, 'en',
      '<div class="status-line status-approved">\u270d\ufe0f &nbsp; Tenant Has Executed the Lease \u2014 Collect Move-In Payment</div>' +
      '<div class="email-body"><p class="greeting">Leasing Team,</p><p class="intro-text">Lease <strong>' + d.app_id + '</strong> has been electronically signed. Please initiate contact to coordinate the move-in payment.</p>' +
      '<div class="section"><div class="section-label">Execution Details</div><div class="callout green"><h4>\u2713 Lease Successfully Executed</h4>' +
      '<div class="financial-row"><span class="f-label">Tenant</span><span class="f-value">' + esc(d.tenant_name) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">Property</span><span class="f-value">' + esc(d.property) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">Email</span><span class="f-value">' + esc(d.email) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">Phone</span><span class="f-value">' + esc(d.phone) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">Signature</span><span class="f-value" style="font-style:italic;">"' + esc(d.signature) + '"</span></div>' +
      '<div class="financial-row"><span class="f-label">Executed At</span><span class="f-value">' + new Date().toLocaleString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '</span></div>' +
      '</div></div><div class="section"><div class="section-label">Quick Actions</div><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">' +
      '<a href="' + adminUrl + '" style="display:inline-block;background:#0a1628;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Admin Dashboard</a>' +
      '<a href="mailto:' + d.email + '?subject=Next Steps \u2014 Move-In \u2014 ' + d.app_id + '" style="display:inline-block;background:#1d4ed8;color:white;text-decoration:none;padding:11px 22px;border-radius:3px;font-size:13px;font-weight:600;">Email Tenant</a>' +
      '</div></div><div class="email-closing"><div class="sign-off">Choice Properties System</div><div class="sign-company">Automated Admin Alert \u2014 ' + d.app_id + '</div></div></div>', cfg), cfg);
}

// ── 9. Move-In Confirmation (bilingual) ───────────────────
function sendMoveInConfirmation(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  send(to, cc, t('moveInSubject', lang) + d.app_id,
    '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="UTF-8"><style>' +
    'body{margin:0;padding:0;background:#f0fdf4;font-family:Arial,Helvetica,sans-serif;}' +
    '.wrap{max-width:580px;margin:0 auto;padding:32px 16px;}.card{background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;}' +
    '.hdr{background:linear-gradient(135deg,#059669,#10b981);padding:36px 40px;text-align:center;}' +
    '.hdr h1{color:white;font-size:22px;margin:12px 0 4px;}.hdr p{color:rgba(255,255,255,.8);font-size:14px;margin:0;}' +
    '.body{padding:32px 40px;}.greeting{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:12px;}' +
    '.intro{font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;}' +
    '.detail-card{background:#f8fafc;border-radius:8px;padding:20px;margin-bottom:20px;}' +
    '.dr{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:14px;}.dr:last-child{border-bottom:none;}' +
    '.dl{color:#64748b;font-weight:500;}.dv{font-weight:600;color:#1e293b;}' +
    '.cta{display:block;background:linear-gradient(to right,#059669,#10b981);color:white;text-align:center;padding:16px;border-radius:50px;font-size:15px;font-weight:700;text-decoration:none;margin:24px 0;}' +
    '.footer{text-align:center;font-size:12px;color:#94a3b8;padding:16px 40px 24px;}' +
    '</style></head><body><div class="wrap"><div class="card">' +
    '<div class="hdr"><div style="font-size:52px;">\ud83c\udfe0</div>' +
    '<h1>' + t('moveInHeadline', lang) + ' ' + esc(d.first_name) + '!</h1>' +
    '<p>' + t('moveInSubheadline', lang) + '</p></div>' +
    '<div class="body"><div class="greeting">' + t('moveInCongrats', lang) + '</div>' +
    '<p class="intro">' + t('moveInIntro', lang) + ' <strong>' + esc(d.property) + '</strong> ' + t('moveInIntro2', lang) + '</p>' +
    '<div class="detail-card">' +
    '<div class="dr"><span class="dl">' + t('moveInPropertyLabel', lang) + '</span><span class="dv">' + esc(d.property) + '</span></div>' +
    '<div class="dr"><span class="dl">' + t('moveInDateLabel2', lang) + '</span><span class="dv">' + esc(d.move_in_date) + '</span></div>' +
    '<div class="dr"><span class="dl">' + t('moveInRentLabel', lang) + '</span><span class="dv">$' + fmtCurrency(d.rent, lang) + '</span></div>' +
    '<div class="dr"><span class="dl">' + t('moveInAppIdLabel', lang) + '</span><span class="dv">' + d.app_id + '</span></div>' +
    (d.notes ? '<div class="dr"><span class="dl">' + t('moveInNotesLabel', lang) + '</span><span class="dv">' + esc(d.notes) + '</span></div>' : '') +
    '</div><p style="font-size:14px;color:#475569;line-height:1.7;">' + t('moveInDueNote', lang) + '</p>' +
    '<a href="' + dashLink + '" class="cta">' + t('moveInDashBtn', lang) + '</a>' +
    '<p style="text-align:center;font-size:13px;color:#64748b;">' + t('textUs', lang) + ' <strong>' + cfg.companyPhone + '</strong> \u00b7 ' + cfg.companyEmail + '</p></div>' +
    '<div class="footer">' + cfg.companyName + ' ' + t('footerMarketplace', lang) + ' \u00b7 ' + t('footerEqualHousing', lang) + '<br>' +
    '\u00a9 ' + new Date().getFullYear() + ' ' + cfg.companyName + '. ' + t('footerRights', lang) + '</div>' +
    '</div></div></body></html>', cfg);
}

// ── 10. Admin Message to Tenant (bilingual) ───────────────
function sendAdminMessage(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  send(to, cc, t('adminMsgSubject', lang) + d.app_id,
    wrap(t('adminMsgTitle', lang), d.app_id, lang,
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.first_name) + ',</p><p class="intro-text">' + t('adminMsgIntro', lang) + ' <strong>' + d.app_id + '</strong>.</p>' +
      '<div class="section"><div class="section-label">' + t('adminMsgLabel', lang) + '</div><div class="callout" style="font-size:15px;line-height:1.7;color:#1a1a1a;">' + esc(d.message) + '</div></div>' +
      '<div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">' + t('replyBtn', lang) + '</a></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 11. Inquiry Reply to Tenant (bilingual) ───────────────
function sendInquiryReply(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  send(to, cc, t('inquiryReplySubject', lang) + d.property,
    wrap(t('inquiryReplyTitle', lang), null, lang,
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.name) + ',</p><p class="intro-text">' + t('inquiryReplyIntro1', lang) + ' <strong>' + esc(d.property) + '</strong>. ' + t('inquiryReplyIntro2', lang) + '</p>' +
      '<div class="callout"><h4>' + t('inquiryDetailsTitle', lang) + '</h4><p>' + esc(d.message) + '</p></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><p class="closing-text">' + t('inquiryClosingNote', lang) + '</p><div class="sign-off">' + t('closingTeam', lang) + '</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 12. New Inquiry to Landlord (English only — internal) ─
function sendNewInquiry(to, cc, d, cfg) {
  send(to, cc, 'New Inquiry for ' + d.property + ' \u2014 from ' + d.tenantName,
    wrap('New Property Inquiry', null, 'en',
      '<div class="email-body"><p class="greeting">You have a new inquiry!</p><p class="intro-text">Someone has sent a message about <strong>' + esc(d.property) + '</strong>. Reach out directly to follow up.</p>' +
      '<div class="section"><div class="section-label">Prospective Tenant</div><table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<tr><td style="padding:8px 0;color:#666;width:140px">Name</td><td style="padding:8px 0;font-weight:600">' + esc(d.tenantName) + '</td></tr>' +
      '<tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0"><a href="mailto:' + d.tenantEmail + '" style="color:#1a5276">' + esc(d.tenantEmail) + '</a></td></tr>' +
      '<tr><td style="padding:8px 0;color:#666">Phone</td><td style="padding:8px 0">' + esc(d.tenantPhone || 'Not provided') + '</td></tr>' +
      '</table></div><div class="callout"><h4>Their Message</h4><p style="white-space:pre-line">' + esc(d.message) + '</p></div>' +
      '<div class="contact-row"><strong>Questions?</strong> &nbsp; Text: ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">Choice Properties</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 13. App ID Recovery (bilingual) ───────────────────────
function sendAppIdRecovery(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  send(to, null, t('appIdRecoverySubject', lang) + d.app_id,
    wrap(t('appIdRecoveryTitle', lang), d.app_id, lang,
      '<div class="email-body"><p class="greeting">' + t('hello', lang) + ',</p><p class="intro-text">' + t('appIdRecoveryIntro', lang) + '</p>' +
      '<div class="callout amber" style="text-align:center"><h4 style="font-size:1.4rem;letter-spacing:.1em;font-family:monospace">' + d.app_id + '</h4></div>' +
      '<div class="cta-wrap"><a href="' + d.dashboard_url + '" class="cta-btn">' + t('trackBtn', lang) + '</a><div class="cta-note">' + t('orVisit', lang) + ' ' + d.dashboard_url + '</div></div>' +
      '<p style="font-size:.75rem;color:#666;margin-top:16px">' + t('appIdRecoveryIgnore', lang) + '</p>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div></div>', cfg), cfg);
}

// ── 14. Lease Sent to Co-Applicant (bilingual) ────────────
function sendLeaseSentCoApplicant(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  send(to, cc, t('leaseCoSubject', lang) + d.app_id + ')',
    wrap(t('leaseCoTitle', lang), d.app_id, lang,
      '<div class="status-line status-lease">' + t('leaseCoStatus', lang) + '</div>' +
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc((d.tenant_name || '').split(' ')[0] || 'Tenant') + ',</p><p class="intro-text">' + t('leaseCoIntro1', lang) + ' <strong>' + esc(d.primary_name) + '</strong>. ' + t('leaseCoIntro2', lang) + '</p>' +
      '<p style="margin-bottom:16px">' + t('leaseCoLiability', lang) + '</p>' +
      '<div class="section"><div class="section-label">' + t('leaseSummaryLabel', lang) + '</div><table class="info-table">' +
      '<tr><td>' + t('leasePropertyLabel', lang) + '</td><td><strong>' + esc(d.property) + '</strong></td></tr>' +
      '<tr><td>' + t('leaseTermLabel2', lang) + '</td><td>' + esc(d.term) + '</td></tr>' +
      '<tr><td>' + t('leaseStartLabel', lang) + '</td><td>' + esc(d.startDate) + '</td></tr>' +
      '<tr><td>' + t('leaseEndLabel', lang) + '</td><td>' + esc(d.endDate) + '</td></tr>' +
      '</table></div><div class="section"><div class="section-label">' + t('financialSummaryLabel', lang) + '</div><div class="callout"><h4>' + t('moveInBreakdownTitle', lang) + '</h4>' +
      '<div class="financial-row"><span class="f-label">' + t('monthlyRentLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.rent, lang) + '</span></div>' +
      '<div class="financial-row"><span class="f-label">' + t('securityDepositLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.deposit, lang) + '</span></div>' +
      '<div class="financial-row total"><span class="f-label">' + t('totalMoveInLabel', lang) + '</span><span class="f-value">$' + fmtCurrency(d.move_in_costs, lang) + '</span></div>' +
      '</div></div><div class="callout amber"><h4>' + t('leaseCoImportantTitle', lang) + '</h4><p>' + t('leaseCoImportantBody', lang) + '</p></div>' +
      '<div class="cta-wrap"><a href="' + d.lease_link + '" class="cta-btn">' + t('signCoBtn', lang) + '</a><div class="cta-note">' + t('orCopyLink', lang) + ' ' + d.lease_link + '</div></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + t('closingTeam', lang) + '</div></div></div>', cfg), cfg);
}

// ── 15. Co-Applicant Application Notification ─────────────
function sendCoApplicantNotification(to, cc, d, cfg) {
  var subject = 'You have been listed on a rental application — ' + cfg.companyName;
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;}' +
    '.wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);}' +
    '.header{background:#1d4ed8;padding:28px 32px;text-align:center;}' +
    '.header h1{margin:0;color:#fff;font-size:20px;font-weight:700;}' +
    '.body{padding:32px 40px;color:#1e293b;}' +
    '.greeting{font-size:18px;font-weight:700;margin-bottom:12px;}' +
    '.intro{margin-bottom:20px;font-size:15px;line-height:1.6;}' +
    '.info-box{background:#f0f7ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin-bottom:20px;}' +
    '.info-box p{margin:6px 0;font-size:14px;}' +
    '.note{font-size:13px;color:#64748b;margin-top:20px;}' +
    '.contact-row{margin-top:24px;font-size:13px;color:#475569;}' +
    '.footer{background:#f8fafc;padding:16px 32px;text-align:center;font-size:12px;color:#94a3b8;}' +
    '</style></head><body>' +
    '<div class="wrap">' +
    '<div class="header"><h1>' + cfg.companyName + ' — Rental Application Notice</h1></div>' +
    '<div class="body">' +
    '<p class="greeting">Hello,</p>' +
    '<p class="intro">You have been listed as a <strong>co-applicant or guarantor</strong> on a rental application submitted to <strong>' + cfg.companyName + '</strong>.</p>' +
    '<div class="info-box">' +
    '<p><strong>Application ID:</strong> ' + (d.app_id || '—') + '</p>' +
    '<p><strong>Primary Applicant:</strong> ' + esc(d.primary_applicant || '—') + '</p>' +
    '<p><strong>Property:</strong> ' + esc(d.property_address || '—') + '</p>' +
    '</div>' +
    '<p>Our leasing team may contact you as part of the review process. If you have questions or did not authorise this listing, please reach out to us directly.</p>' +
    '<div class="contact-row"><strong>Questions?</strong> &nbsp; Text or call ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
    '</div>' +
    '<div class="footer">&copy; ' + new Date().getFullYear() + ' ' + cfg.companyName + '. This is an automated notice — please do not reply to this email.</div>' +
    '</div>' +
    '</body></html>';
  send(to, cc, subject, html, cfg);
}

// ── 16. New Message to Landlord (English only — internal) ──
// Triggered when tenant sends an inquiry or replies to landlord.
// Data: { app_id?, landlordName, tenantName, tenantEmail?, message, property? }
function sendNewMessageLandlord(to, cc, d, cfg) {
  var dashLink = cfg.dashboardUrl + '/landlord/applications.html' + (d.app_id ? '?highlight=' + d.app_id : '');
  var propertyLabel = d.property || d.propertyAddress || 'your property';
  var senderLine = d.tenantEmail
    ? '<tr><td style="padding:8px 0;color:#666;width:140px">Email</td><td style="padding:8px 0"><a href="mailto:' + d.tenantEmail + '" style="color:#1a5276">' + esc(d.tenantEmail) + '</a></td></tr>'
    : '';
  send(to, cc,
    '[Choice Properties] New Message from ' + (d.tenantName || 'Tenant') + ' \u2014 ' + propertyLabel,
    wrap('New Message from Tenant', d.app_id || null, 'en',
      '<div class="status-line" style="color:#1e40af;background:#eff6ff">\ud83d\udcac &nbsp; You have a new message from a tenant</div>' +
      '<div class="email-body"><p class="greeting">Hi ' + esc(d.landlordName || 'there') + ',</p>' +
      '<p class="intro-text">You have received a new message regarding <strong>' + esc(propertyLabel) + '</strong>.</p>' +
      '<div class="section"><div class="section-label">Sender</div><table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<tr><td style="padding:8px 0;color:#666;width:140px">Name</td><td style="padding:8px 0;font-weight:600">' + esc(d.tenantName || 'Tenant') + '</td></tr>' +
      senderLine +
      '</table></div>' +
      '<div class="callout"><h4>Message</h4><p style="white-space:pre-line;font-size:14px;line-height:1.7">' + esc(d.message) + '</p></div>' +
      (d.app_id ? '<div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">View in Dashboard &rarr;</a></div>' : '') +
      '<div class="contact-row"><strong>Questions?</strong> &nbsp; Text: ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">Choice Properties</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 17. New Message to Tenant (bilingual) ─────────────────
// Triggered when landlord or admin sends a message to tenant.
// Data: { app_id, first_name, message, preferred_language, sender_name? }
function sendNewMessageTenant(to, cc, d, cfg) {
  var lang = d.preferred_language || 'en';
  var dashLink = cfg.dashboardUrl + '/apply/dashboard.html?id=' + d.app_id;
  var senderName = d.sender_name || cfg.companyName + ' Leasing Team';
  var subjectEn = '[Choice Properties] New Message Regarding Your Application \u2014 ' + d.app_id;
  var subjectEs = '[Choice Properties] Nuevo Mensaje Sobre Su Solicitud \u2014 ' + d.app_id;
  var subject = lang === 'es' ? subjectEs : subjectEn;
  var titleEn = 'Message from Your Leasing Team';
  var titleEs = 'Mensaje de Su Equipo de Arrendamiento';
  var introEn = 'Your leasing team has sent you a message regarding your application <strong>' + d.app_id + '</strong>.';
  var introEs = 'Su equipo de arrendamiento le ha enviado un mensaje relacionado con su solicitud <strong>' + d.app_id + '</strong>.';
  var msgLabelEn = 'Message';
  var msgLabelEs = 'Mensaje';
  var replyBtnEn = 'Reply on My Dashboard';
  var replyBtnEs = 'Responder en Mi Panel';
  send(to, cc, subject,
    wrap(lang === 'es' ? titleEs : titleEn, d.app_id, lang,
      '<div class="email-body"><p class="greeting">' + t('dear', lang) + ' ' + esc(d.first_name) + ',</p>' +
      '<p class="intro-text">' + (lang === 'es' ? introEs : introEn) + '</p>' +
      '<div class="section"><div class="section-label">' + (lang === 'es' ? msgLabelEs : msgLabelEn) + '</div>' +
      '<div class="callout" style="font-size:15px;line-height:1.7;color:#1a1a1a;">' + esc(d.message) + '</div></div>' +
      '<div class="cta-wrap"><a href="' + dashLink + '" class="cta-btn">' + (lang === 'es' ? replyBtnEs : replyBtnEn) + '</a></div>' +
      '<div class="contact-row"><strong>' + t('questions', lang) + '</strong> &nbsp; ' + t('textUs', lang) + ' ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">' + esc(senderName) + '</div><div class="sign-company">' + cfg.companyEmail + '</div></div></div>', cfg), cfg);
}

// ── 18. New Application to Landlord (English only — internal) ─
// Triggered when tenant submits application for landlord's property.
// Data: { app_id, applicantName, propertyAddress, landlordName, monthly_rent?, email, phone }
function sendNewApplication(to, cc, d, cfg) {
  var dashLink = cfg.dashboardUrl + '/landlord/applications.html';
  var applicantName = d.applicantName || (esc(d.first_name) + ' ' + esc(d.last_name)).trim() || 'Applicant';
  var propertyAddr  = d.propertyAddress || d.property_address || 'your property';
  var rentLabel = d.monthly_rent ? ('$' + parseFloat(d.monthly_rent).toLocaleString('en-US', { minimumFractionDigits: 2 })) : 'See dashboard';
  send(to, cc,
    '[Choice Properties] New Application \u2014 ' + applicantName + ' \u2014 ' + propertyAddr,
    wrap('New Rental Application', d.app_id, 'en',
      '<div class="status-line status-pending">\ud83d\udccb &nbsp; A new application has been submitted for your property</div>' +
      '<div class="email-body"><p class="greeting">Hi ' + esc(d.landlordName || 'there') + ',</p>' +
      '<p class="intro-text">A new rental application has been submitted for <strong>' + esc(propertyAddr) + '</strong>. Log in to your landlord dashboard to review the full application.</p>' +
      '<div class="section"><div class="section-label">Application Summary</div><table class="info-table">' +
      '<tr><td>Applicant</td><td><strong>' + esc(applicantName) + '</strong></td></tr>' +
      '<tr><td>Property</td><td>' + esc(propertyAddr) + '</td></tr>' +
      '<tr><td>Monthly Rent</td><td>' + rentLabel + '</td></tr>' +
      '<tr><td>Application ID</td><td style="font-family:monospace">' + d.app_id + '</td></tr>' +
      '<tr><td>Move-In</td><td>' + esc(d.requested_move_in || d.requested_move_in_date || 'Not specified') + '</td></tr>' +
      '<tr><td>Lease Term</td><td>' + esc(d.desired_lease_term || 'Not specified') + '</td></tr>' +
      '</table></div>' +
      '<div class="section"><a href="' + dashLink + '" style="display:inline-block;background:#0a1628;color:white;text-decoration:none;padding:12px 24px;border-radius:3px;font-size:14px;font-weight:600;">Review Application \u2192</a></div>' +
      '<div class="contact-row"><strong>Questions?</strong> &nbsp; Text: ' + cfg.companyPhone + ' &nbsp;&middot;&nbsp; ' + cfg.companyEmail + '</div>' +
      '<div class="email-closing"><div class="sign-off">Choice Properties System</div><div class="sign-company">Automated Notification \u2014 ' + d.app_id + '</div></div></div>', cfg), cfg);
}

// ============================================================
// SHARED HELPERS
// ============================================================

function buildPaymentMethodList(d) {
  var methods = [];
  if (d.primary_payment_method)      methods.push(d.primary_payment_method === 'Other' ? d.primary_payment_method_other : d.primary_payment_method);
  if (d.alternative_payment_method)  methods.push(d.alternative_payment_method === 'Other' ? d.alternative_payment_method_other : d.alternative_payment_method);
  if (d.third_choice_payment_method) methods.push(d.third_choice_payment_method === 'Other' ? d.third_choice_payment_method_other : d.third_choice_payment_method);
  return methods.filter(Boolean);
}

// ── Email wrapper — bilingual, sets html[lang] correctly ──
function wrap(title, appId, lang, content, cfg) {
  var htmlLang = (lang === 'es') ? 'es' : 'en';
  var refLine = appId ? '<div class="header-ref">Ref: ' + appId + ' &nbsp;&middot;&nbsp; ' + t('tagline', lang) + '</div>' : '';
  return '<!DOCTYPE html><html lang="' + htmlLang + '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' +
    '* { margin:0; padding:0; box-sizing:border-box; }' +
    'body { margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; color:#1a1a1a; }' +
    '.email-wrapper { max-width:600px; margin:24px auto; background:#ffffff; border:1px solid #e0e0e0; border-radius:4px; overflow:hidden; }' +
    '.email-header { background:#ffffff; padding:32px 40px 24px; border-bottom:3px solid #1a5276; }' +
    '.header-brand { font-size:20px; font-weight:700; color:#1a1a1a; letter-spacing:0.3px; margin-bottom:3px; }' +
    '.header-sub { font-size:12px; color:#666666; margin-bottom:14px; }' +
    '.header-title { font-size:22px; font-weight:700; color:#1a1a1a; line-height:1.3; margin-bottom:8px; }' +
    '.header-ref { font-size:12px; color:#888888; font-family:monospace; }' +
    '.status-line { padding:12px 40px; font-size:13px; font-weight:600; border-bottom:1px solid #e8e8e8; }' +
    '.status-pending { color:#b45309; } .status-paid { color:#166534; } .status-approved { color:#166534; } .status-denied { color:#991b1b; } .status-lease { color:#1e40af; }' +
    '.email-body { padding:36px 40px; }' +
    '.greeting { font-size:16px; font-weight:600; color:#1a1a1a; margin-bottom:16px; }' +
    '.intro-text { font-size:14px; color:#444444; line-height:1.7; margin-bottom:28px; }' +
    '.section { margin-bottom:28px; }' +
    '.section-label { font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#888888; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #e8e8e8; }' +
    '.info-table { width:100%; border-collapse:collapse; }' +
    '.info-table tr td { padding:10px 0; font-size:14px; vertical-align:top; border-bottom:1px solid #f0f0f0; }' +
    '.info-table tr:last-child td { border-bottom:none; }' +
    '.info-table td:first-child { width:42%; font-weight:600; color:#555555; padding-right:12px; }' +
    '.callout { border-left:3px solid #1a5276; padding:14px 18px; margin:20px 0; background:#ffffff; }' +
    '.callout.green { border-color:#166534; } .callout.amber { border-color:#b45309; } .callout.red { border-color:#991b1b; }' +
    '.callout h4 { font-size:13px; font-weight:700; color:#1a1a1a; margin-bottom:6px; }' +
    '.callout p { font-size:13px; color:#444444; line-height:1.65; }' +
    '.steps-list { list-style:none; margin:0; padding:0; }' +
    '.steps-list li { display:flex; align-items:flex-start; gap:14px; padding:11px 0; border-bottom:1px solid #f0f0f0; font-size:14px; color:#333333; line-height:1.6; }' +
    '.steps-list li:last-child { border-bottom:none; }' +
    '.step-num { flex-shrink:0; width:24px; height:24px; background:#1a5276; color:#ffffff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }' +
    '.financial-row { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f0f0f0; font-size:13px; }' +
    '.financial-row:last-child { border-bottom:none; }' +
    '.financial-row.total { font-weight:700; font-size:14px; padding-top:12px; }' +
    '.f-label { color:#555555; } .f-value { font-weight:600; color:#1a1a1a; }' +
    '.cta-wrap { text-align:center; margin:28px 0; }' +
    '.cta-btn { display:inline-block; background:#1a5276; color:#ffffff; text-decoration:none; padding:15px 36px; border-radius:3px; font-size:14px; font-weight:700; letter-spacing:0.5px; }' +
    '.cta-note { font-size:11px; color:#888888; margin-top:10px; word-break:break-all; }' +
    '.contact-row { background:#f8f9fa; border-radius:3px; padding:12px 16px; font-size:13px; color:#444444; margin:24px 0; }' +
    '.email-closing { margin-top:28px; padding-top:20px; border-top:1px solid #e8e8e8; }' +
    '.closing-text { font-size:14px; color:#444444; line-height:1.7; margin-bottom:16px; }' +
    '.sign-off { font-size:14px; font-weight:700; color:#1a1a1a; } .sign-company { font-size:12px; color:#888888; margin-top:3px; }' +
    '.pay-pill { display:inline-block; border:1px solid #cccccc; border-radius:3px; padding:5px 12px; font-size:13px; color:#333333; margin:3px 4px 3px 0; }' +
    '.email-footer { background:#f8f9fa; padding:20px 40px; border-top:1px solid #e8e8e8; text-align:center; }' +
    '.footer-name { font-size:13px; font-weight:700; color:#1a1a1a; margin-bottom:6px; }' +
    '.footer-details { font-size:12px; color:#666666; line-height:1.7; margin-bottom:8px; }' +
    '@media only screen and (max-width:600px) { .email-body { padding:24px 20px; } .email-header { padding:24px 20px 18px; } .email-footer { padding:16px 20px; } .status-line { padding:10px 20px; } }' +
    '</style></head><body>' +
    '<div class="email-wrapper">' +
    '<div class="email-header"><div class="header-brand">' + cfg.companyName + '</div><div class="header-sub">' + t('headerSub', lang) + '</div><div class="header-title">' + title + '</div>' + refLine + '</div>' +
    content +
    '<div class="email-footer"><div class="footer-name">' + cfg.companyName + '</div><div class="footer-details">' + cfg.companyName + ' ' + t('footerMarketplace', lang) + '<br>' + cfg.companyPhone + ' (' + (lang === 'es' ? 'Solo Texto' : 'Text Only') + ') &middot; ' + cfg.companyEmail + '<br>' + t('tagline', lang) + '</div>' +
    '<div style="font-size:11px;color:#888;margin-top:12px;line-height:1.6;">' +
      '<a href="https://choice-properties-site.pages.dev/policies.html" style="color:#888;text-decoration:underline;">' + (lang === 'es' ? 'Marco de Pol\u00edticas' : 'Policy Framework') + '</a> &middot; ' +
      '<a href="https://choice-properties-site.pages.dev/terms.html" style="color:#888;text-decoration:underline;">' + (lang === 'es' ? 'T\u00e9rminos' : 'Terms') + '</a> &middot; ' +
      '<a href="https://choice-properties-site.pages.dev/privacy.html" style="color:#888;text-decoration:underline;">' + (lang === 'es' ? 'Privacidad' : 'Privacy') + '</a> &middot; ' +
      '<a href="https://choice-properties-site.pages.dev/fair-housing.html" style="color:#888;text-decoration:underline;">' + (lang === 'es' ? 'Vivienda Justa' : 'Fair Housing') + '</a> &middot; ' +
      '<a href="https://choice-properties-site.pages.dev/policy-changelog.html" style="color:#888;text-decoration:underline;">' + (lang === 'es' ? 'Historial' : 'Changelog') + '</a>' +
    '</div>' +
    '<div style="font-size:10px;color:#9aa3af;margin-top:10px;line-height:1.5;">' +
      (lang === 'es'
        ? 'Recibe este correo transaccional porque envi\u00f3 una solicitud o firm\u00f3 un contrato a trav\u00e9s de Choice Properties. No es un mensaje de marketing.<br><strong>SMS:</strong> Responda HELP para ayuda, STOP para cancelar. Pueden aplicar tarifas de mensajes y datos. Cancelar SMS no afecta los correos de la solicitud.<br>Marco de Pol\u00edticas v2.0 &middot; Vigente 22 de abril de 2026.'
        : 'You are receiving this transactional email because you submitted an application or signed a lease through Choice Properties. This is not a marketing message.<br><strong>SMS:</strong> Reply HELP for help, STOP to opt out. Msg &amp; data rates may apply. SMS opt-out does not affect application emails.<br>Policy Framework v2.0 &middot; Effective April 22, 2026.') +
    '</div>' +
    '<div style="font-size:10px;color:#aaaaaa;margin-top:8px;line-height:1.6;">' + t('confidential', lang) + ' &copy; ' + new Date().getFullYear() + ' ' + cfg.companyName + '. ' + t('footerRights', lang) + '</div>' +
    '</div></div></body></html>';
}
