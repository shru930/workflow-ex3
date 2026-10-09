"""Structural checks for the three BPMN models in this repository.

Needs only the Python 3 standard library:

    python validate.py
"""
import sys
import xml.etree.ElementTree as ET
from collections import Counter, deque

NS = {
    'bpmn': 'http://www.omg.org/spec/BPMN/20100524/MODEL',
    'bpmndi': 'http://www.omg.org/spec/BPMN/20100524/DI',
    'zeebe': 'http://camunda.org/schema/zeebe/1.0',
}
B = '{%s}' % NS['bpmn']

MODELS = [
    '01-student-project-allocation.bpmn',
    '02-shipment-exception-management.bpmn',
    '03-loan-origination.bpmn',
]

TASKS = {'task', 'userTask', 'serviceTask', 'sendTask', 'receiveTask', 'businessRuleTask', 'scriptTask', 'manualTask'}
GATEWAYS = {'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway'}
EVENTS = {'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent'}
NODES = TASKS | GATEWAYS | EVENTS | {'subProcess'}
JOB_TASKS = {'serviceTask', 'sendTask', 'businessRuleTask'}


def local(tag):
    return tag.split('}')[1]


def check(path):
    tree = ET.parse(path)
    root = tree.getroot()
    proc = root.find('bpmn:process', NS)
    results = []

    def res(name, ok, detail=''):
        results.append((name, ok, detail))

    nodes, flows, parent = {}, {}, {}

    def walk(container, scope):
        for el in container:
            t = local(el.tag)
            if t in NODES:
                nodes[el.get('id')] = el
                parent[el.get('id')] = scope
                if t == 'subProcess':
                    walk(el, el.get('id'))
            elif t == 'sequenceFlow':
                flows[el.get('id')] = el
                parent[el.get('id')] = scope
    walk(proc, None)

    inc, out = Counter(), Counter()
    bad_refs = []
    for fid, f in flows.items():
        s, t = f.get('sourceRef'), f.get('targetRef')
        if s not in nodes or t not in nodes:
            bad_refs.append(fid)
        out[s] += 1
        inc[t] += 1
        if parent.get(s) != parent.get(t):
            bad_refs.append(fid + ' (crosses sub-process boundary)')
    res('Every sourceRef / targetRef resolves to a flow node in the same scope', not bad_refs, ', '.join(bad_refs))

    bad = [i for i, n in nodes.items() if local(n.tag) == 'startEvent' and inc[i]]
    bad += [i for i, n in nodes.items() if local(n.tag) == 'endEvent' and out[i]]
    res('Start events have no incoming flow; end events have no outgoing flow', not bad, ', '.join(bad))

    bad = []
    for i, n in nodes.items():
        t = local(n.tag)
        comp = n.get('isForCompensation') == 'true'
        evsub = t == 'subProcess' and n.get('triggeredByEvent') == 'true'
        if comp or evsub:
            continue
        if t in TASKS | GATEWAYS | {'subProcess', 'intermediateCatchEvent', 'intermediateThrowEvent'}:
            if not inc[i] or not out[i]:
                bad.append(i)
        if t == 'boundaryEvent' and not out[i] and n.find('bpmn:compensateEventDefinition', NS) is None:
            bad.append(i)
    res('Every task, gateway and intermediate event has incoming and outgoing flow', not bad, ', '.join(bad))

    # reachability: from every start event, following flows and boundary events
    attached = {}
    for i, n in nodes.items():
        if local(n.tag) == 'boundaryEvent':
            attached.setdefault(n.get('attachedToRef'), []).append(i)
    succ = {i: [] for i in nodes}
    for f in flows.values():
        succ[f.get('sourceRef')].append(f.get('targetRef'))
    for host, bs in attached.items():
        succ[host] += bs
    for i, n in nodes.items():                       # entering a sub-process starts its children
        if local(n.tag) == 'subProcess':
            succ[i] += [c for c, p in parent.items() if p == i and c in nodes and local(nodes[c].tag) == 'startEvent']
    starts = [i for i, n in nodes.items() if local(n.tag) == 'startEvent' and parent[i] is None]
    evsubs = [i for i, n in nodes.items() if local(n.tag) == 'subProcess' and n.get('triggeredByEvent') == 'true']
    seen, q = set(starts + evsubs), deque(starts + evsubs)
    while q:
        x = q.popleft()
        for y in succ[x]:
            if y not in seen:
                seen.add(y); q.append(y)
    handlers = {i for i, n in nodes.items() if n.get('isForCompensation') == 'true'}
    unreached = [i for i in nodes if i not in seen and i not in handlers]
    res('Every element reachable from a start event', not unreached, ', '.join(unreached))

    bad = []
    for i, n in nodes.items():
        t = local(n.tag)
        if t in ('exclusiveGateway', 'inclusiveGateway') and out[i] > 1:
            dflt = n.get('default')
            always = any(f.get('sourceRef') == i and (f.findtext('bpmn:conditionExpression', '', NS).strip() == '=true')
                         for f in flows.values())
            if not dflt and not (t == 'inclusiveGateway' and always):
                bad.append(i + ' (no default)')
            for fid, f in flows.items():
                if f.get('sourceRef') == i and fid != dflt and f.find('bpmn:conditionExpression', NS) is None:
                    bad.append(fid)
    res('Every splitting XOR / OR gateway has a default (or always-true) flow and conditions on the rest', not bad, ', '.join(bad))

    bad = []
    for i, n in nodes.items():
        if local(n.tag) == 'eventBasedGateway':
            for f in flows.values():
                if f.get('sourceRef') == i and local(nodes[f.get('targetRef')].tag) not in ('intermediateCatchEvent', 'receiveTask'):
                    bad.append(f.get('id'))
    res('Event-based gateways lead only to catch events', not bad, ', '.join(bad))

    bad = [i for i, n in nodes.items() if local(n.tag) in GATEWAYS and inc[i] > 1 and out[i] > 1]
    res('No gateway both joins and splits', not bad, ', '.join(bad))

    bad = [i for i, n in nodes.items() if local(n.tag) in TASKS and inc[i] > 1]
    res('No task has more than one incoming flow (merges are explicit)', not bad, ', '.join(bad))

    bad = []
    for i, n in nodes.items():
        t = local(n.tag)
        ext = n.find('bpmn:extensionElements', NS)
        if t in JOB_TASKS and (ext is None or ext.find('zeebe:taskDefinition', NS) is None):
            bad.append(i)
        if t == 'scriptTask' and (ext is None or ext.find('zeebe:script', NS) is None):
            bad.append(i)
        if t == 'userTask' and (ext is None or ext.find('zeebe:userTask', NS) is None):
            bad.append(i)
    res('Every executable task carries its Zeebe definition', not bad, ', '.join(bad))

    msgs = {m.get('id'): m for m in root.findall('bpmn:message', NS)}
    bad = []
    for i, n in nodes.items():
        refs = [n.get('messageRef')] if n.get('messageRef') else []
        refs += [d.get('messageRef') for d in n.findall('bpmn:messageEventDefinition', NS)]
        is_top_start = local(n.tag) == 'startEvent' and parent[i] is None
        for r in refs:
            if r not in msgs:
                bad.append(i)
            elif not is_top_start and msgs[r].find('.//zeebe:subscription', NS) is None:
                bad.append(i + ' (no correlation key)')
    res('Every message catch has a defined message with a correlation key', not bad, ', '.join(bad))

    errs = {e.get('id') for e in root.findall('bpmn:error', NS)}
    bad = [i for i, n in nodes.items() for d in n.findall('bpmn:errorEventDefinition', NS) if d.get('errorRef') not in errs]
    res('Every error event references a defined error code', not bad, ', '.join(bad))

    di = {s.get('bpmnElement') for s in root.iter('{%s}BPMNShape' % NS['bpmndi'])}
    di |= {s.get('bpmnElement') for s in root.iter('{%s}BPMNEdge' % NS['bpmndi'])}
    missing = [i for i in list(nodes) + list(flows) if i not in di]
    res('Every element has BPMNShape / BPMNEdge diagram data', not missing, ', '.join(missing))

    lanes = [ref.text for ref in proc.iter(B + 'flowNodeRef')]
    top = [i for i in nodes if parent[i] is None]
    bad = [i for i in top if lanes.count(i) != 1]
    res('Every top-level element sits in exactly one lane', not bad, ', '.join(bad))

    bad = [i for i, n in nodes.items() if n.find('bpmn:documentation', NS) is None]
    res('Every flow node carries a <documentation> entry', not bad, ', '.join(bad))

    counts = Counter(local(n.tag) for n in nodes.values())
    bcount = Counter()
    for n in nodes.values():
        if local(n.tag) == 'boundaryEvent':
            d = [local(c.tag) for c in n if c.tag.endswith('EventDefinition')][0]
            bcount[d.replace('EventDefinition', '')] += 1
    return results, counts, bcount, len(flows), len(lanes and proc.findall('.//bpmn:lane', NS))


def main():
    ok_all = True
    for path in MODELS:
        results, counts, bcount, nflows, nlanes = check(path)
        print(f'\n== {path}')
        for name, ok, detail in results:
            ok_all &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f'  -> {detail}' if detail else ''))
        tasks = {k: v for k, v in counts.items() if k in TASKS}
        gws = {k: v for k, v in counts.items() if k in GATEWAYS}
        print(f'  lanes={nlanes}  sequence flows={nflows}  sub-processes={counts["subProcess"]}')
        print(f'  tasks: {dict(sorted(tasks.items()))}')
        print(f'  gateways: {dict(sorted(gws.items()))}')
        print(f'  boundary events: {dict(sorted(bcount.items()))}')
        print(f'  end events: {counts["endEvent"]}')
    print('\nALL CHECKS PASSED' if ok_all else '\nSOME CHECKS FAILED')
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
