const { deploy, run, jobTypes } = require('./drive');
const uid = () => Math.random().toString(36).slice(2, 8);

const F1 = '01-student-project-allocation.bpmn', F2 = '02-shipment-exception-management.bpmn', F3 = '03-loan-origination.bpmn';

function a1(name, opts) {
  const id = 'P-' + uid();
  return {
    name, process: 'student-project-allocation', types: jobTypes(F1), start: {}, id,
    vars: { proposalId: id, similarityThreshold: 0.4 },
    jobs: Object.assign({
      'validate-proposal': { validation: 'VALID' },
      'similarity-check': { similarityScore: 0.1 },
      'match-guide': { matchedGuide: 'G-17' },
    }, opts.jobs || {}),
    users: Object.assign({ Task_EvaluateProposal: { committeeDecision: 'APPROVE' } }, opts.users || {}),
    msgs: { Gw_GuideReply: opts.reply || (() => ({ name: 'guide-accepted', key: id })) },
  };
}
function a2(name, opts) {
  const t = 'T-' + uid();
  return {
    name, process: 'shipment-exception-management', types: jobTypes(F2), start: { message: 'shipment-booked' }, idVar: 'trackingId',
    vars: Object.assign({ bookingId: 'B-' + t, trackingId: t, international: false }, opts.vars || {}),
    jobs: Object.assign({
      'validate-and-price-booking': { bookingValid: true },
      'plan-route': { remainingLegs: ['HUB-A', 'HUB-B'] },
      'sort-and-scan': { damaged: false },
      'file-customs': { customsCleared: true },
    }, opts.jobs || {}),
    users: Object.assign({ Task_CollectParcel: { pickedUp: true }, Task_AttemptDelivery: { outcome: 'DELIVERED' } }, opts.users || {}),
    msgs: Object.assign({ Gw_TransitEvent: () => ({ name: 'arrival-scan', key: t }) }, opts.msgs ? opts.msgs(t) : {}),
    stopAt: opts.stopAt,
  };
}
function a3(name, opts) {
  const id = 'A-' + uid();
  return {
    name, process: 'loan-origination', types: jobTypes(F3), start: { message: 'loan-application-submitted' }, idVar: 'applicationId',
    vars: Object.assign({ applicationId: id, loanAmount: 500000, eddThreshold: 2000000, secured: false, hasGuarantor: false,
      approvedAmount: 500000, monthlyRate: 0.009, tenureMonths: 36 }, opts.vars || {}),
    jobs: Object.assign({
      'check-document-completeness': { documentsComplete: true },
      'verify-kyc': { kycMatch: true },
      'screen-fraud-aml': { complianceFlag: false },
      'retrieve-credit-score': { creditScore: 780 },
      'score-application': { risk: { decision: 'AUTO_APPROVE' } },
      'verify-signature': { signatureValid: true },
      'verify-beneficiary': { beneficiaryValid: true },
    }, opts.jobs || {}),
    users: Object.assign({}, opts.users || {}),
    msgs: Object.assign({
      Task_AwaitAcceptance: () => ({ name: 'offer-accepted', key: id }),
      Task_AwaitSignature: () => ({ name: 'agreement-signed', key: id }),
    }, opts.msgs ? opts.msgs(id) : {}),
  };
}

let n1 = 0, n2 = 0;
const SCENARIOS = [
  a1('A1 happy path', {}),
  a1('A1 F1+F3+F5+F9+F10: correction round, similarity false positive, revision, guide declines, mail down', {
    jobs: {
      'validate-proposal': c => ({ validation: c === 1 ? 'INCOMPLETE' : 'VALID' }),
      'similarity-check': { similarityScore: 0.9 },
      'notify-allocation': { error: 'NOTIFY_FAILED' },
    },
    users: { Task_ReviewMatch: { overlap: 'FALSE_POSITIVE' }, Task_EvaluateProposal: c => ({ committeeDecision: c === 1 ? 'REVISE' : 'APPROVE' }) },
    reply: function () { n1++; return { name: n1 === 1 ? 'guide-declined' : 'guide-accepted', key: this.id }; },
  }),
  a1('A1 F2: team rule broken', { jobs: { 'validate-proposal': { validation: 'TEAM_RULE' } } }),
  a1('A1 F8: no eligible guide -> coordinator arranges one', { jobs: { 'match-guide': { matchedGuide: null } }, users: { Task_ManualAllocation: { guideArranged: true } } }),
  a1('A1 F11: team withdraws during allocation', { reply: function () { return { name: 'allocation-withdrawal', key: this.id, vars: { withdrawnBy: 'TEAM' } }; } }),
  a1('A1 F6: rejected twice', { users: { Task_EvaluateProposal: { committeeDecision: 'REJECT' } } }),
  a2('A2 happy path', {}),
  a2('A2 E5+E6+E9: scan failure, delay with reroute, customs hold', {
    vars: { international: true },
    jobs: { 'sort-and-scan': c => (c === 1 ? { error: 'SCAN_FAILED' } : { damaged: false }), 'file-customs': c => ({ customsCleared: c > 1 }) },
    msgs: t => ({
      Gw_TransitEvent: () => { n2++; return n2 === 1 ? { name: 'delay-reported', key: t, vars: { routeBlocked: true, vehicleDown: false } } : { name: 'arrival-scan', key: t }; },
      Task_AwaitDocs: () => ({ name: 'customs-documents', key: t }),
    }),
  }),
  a2('A2 E1: pickup fails -> waits for next pickup slot', { users: { Task_CollectParcel: { pickedUp: false } }, stopAt: 'Catch_NextPickup' }),
  a2('A2 E7: not at home -> waits for next delivery day', { users: { Task_AttemptDelivery: { outcome: 'NOT_HOME' } }, stopAt: 'Catch_NextDay' }),
  a2('A2 E3: damaged at hub, insured', { jobs: { 'sort-and-scan': { damaged: true } }, users: { Task_InspectDamage: { insured: true } } }),
  a2('A2 E10: cancelled in transit', { msgs: t => ({ Gw_TransitEvent: () => ({ name: 'shipment-cancelled', key: t }) }) }),
  a2('A2 E8: refused at door', { users: { Task_AttemptDelivery: { outcome: 'REFUSED' } } }),
  a3('A3 happy path (auto-approve)', {}),
  a3('A3 L1+L2+L4+L6+L7+L8: missing docs, manual KYC, bureau down, restructure, extra checks, committee', {
    vars: { secured: true, loanAmount: 3000000 },
    jobs: {
      'check-document-completeness': c => ({ documentsComplete: c > 1 }),
      'verify-kyc': { kycMatch: false },
      'retrieve-credit-score': { error: 'BUREAU_UNAVAILABLE' },
      'score-application': c => ({ risk: { decision: c === 1 ? 'COUNTER_OFFER' : 'MANUAL_REVIEW' } }),
    },
    users: { Task_ManualKYC: { kycResolved: true }, Task_Restructure: {}, Task_Underwrite: { uwDecision: 'ESCALATE' }, Task_Committee: { committeeApproved: true } },
    msgs: id => ({ Task_AwaitDocs: () => ({ name: 'documents-resubmitted', key: id }) }),
  }),
  a3('A3 L3: fraud confirmed -> terminate', { jobs: { 'screen-fraud-aml': { complianceFlag: true } }, users: { Task_Investigate: { fraudConfirmed: true } } }),
  a3('A3 L5: score below cut-off -> rejected', { jobs: { 'score-application': { risk: { decision: 'REJECT' } } } }),
  a3('A3 L9: applicant declines offer', { msgs: id => ({ Task_AwaitAcceptance: () => ({ name: 'offer-declined', key: id }) }) }),
  a3('A3 L10: withdrawal at offer stage (event sub-process + compensation)', { msgs: id => ({ Task_AwaitAcceptance: () => ({ name: 'application-withdrawn', key: id }) }) }),
  a3('A3 L11+L12: bad signature once, payment fails, unresolved -> compensation', {
    jobs: { 'verify-signature': c => ({ signatureValid: c > 1 }), 'disburse-funds': { error: 'PAYMENT_FAILED' } },
    users: { Task_HoldContact: { issueResolved: false } },
  }),
];

(async () => {
  const only = process.argv[2];
  const d = await deploy([F1, F2, F3]);
  console.log('DEPLOYED:', (d.deployments || []).map(x => x.processDefinition && `${x.processDefinition.processDefinitionId} v${x.processDefinition.processDefinitionVersion}`).join(', '));
  for (const sc of SCENARIOS) {
    if (only && !sc.name.startsWith(only)) continue;
    for (const k of Object.keys(sc.msgs)) sc.msgs[k] = sc.msgs[k].bind(sc);
    let r;
    try { r = await run(sc); } catch (e) { r = { state: 'DRIVER ERROR', trail: [], detail: [String(e).slice(0, 300)] }; }
    console.log(`\n### ${sc.name}\n  instance ${r.key}: ${r.state}` +
      (r.ends ? `  -> end: ${r.ends.join(', ')}` : '') + (r.detail ? `\n  DETAIL: ${r.detail.join(' | ')}` : '') +
      (r.waitingAt ? `\n  waiting at: ${r.waitingAt.join(', ')}` : ''));
    console.log('  path: ' + r.trail.join(' > '));
  }
})().catch(e => { console.error(e); process.exit(1); });
