"""Synthetic reader controls. Build-context is explicitly mocked; no Windows tests run."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
loader = importlib.util.spec_from_file_location('git_controls', HERE / 'read_git_launch_controls.py')
r = importlib.util.module_from_spec(loader)
loader.loader.exec_module(r)
REPO = HERE.parents[2]
HEAD = 'a' * 40
SOURCE = (REPO / r.SCRIPT).read_bytes()
SPECS = r.specs(SOURCE.decode())


def text_for(spec, outcome='ok'):
    counts = {'ok': ('ok', 1, 0, 0), 'FAILED': ('FAILED', 0, 1, 0), 'ignored': ('ok', 0, 0, 1)}[outcome]
    return f"running 1 test\ntest {spec['test']} ... {outcome}\n\ntest result: {counts[0]}. {counts[1]} passed; {counts[2]} failed; {counts[3]} ignored; 0 measured; 0 filtered out; finished in 0.01s\n"


class ReaderControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.mapping = {r.SCRIPT: r.legacy.sha(SOURCE), 'src-tauri/src/lib.rs': 'b' * 64}
        self.selection = {'testBinarySha256': 'c' * 64, 'fixtureSha256': 'd' * 64}
        self.base = {'issues': [], 'buildSelection': self.selection}
        self.write('inputs-before.json', self.mapping)
        self.write('inputs-after.json', self.mapping)
        for mode, specs in SPECS.items():
            prefix = 'git-launch-controls-' + mode
            self.write(prefix + '.inputs-before.json', self.mapping)
            self.write(prefix + '.inputs-after.json', self.mapping)
            groups = []
            for spec in specs:
                out = text_for(spec)
                err = (spec['marker'] + '\n') if spec['marker'] else ''
                rec = {'head': HEAD, 'mode': mode, 'name': spec['name'], 'filter': spec['test'],
                       'exactFilter': True, 'explicitIgnored': False, 'invocationReturned': True,
                       'terminationRequestedByRunner': False, 'exitCode': 0, 'expectedPhaseMarker': spec['marker'],
                       'phaseMarkerMatches': int(bool(spec['marker'])), 'exactPassed': True,
                       'stdoutSha256': r.legacy.sha(out.encode()), 'stderrSha256': r.legacy.sha(err.encode())}
                name = prefix + '-' + spec['name']
                self.write(name + '.result.json', rec)
                (self.root / (name + '.stdout.log')).write_text(out)
                (self.root / (name + '.stderr.log')).write_text(err)
                groups.append(rec)
            self.write(prefix + '.result.json', {'head': HEAD, 'finalHead': HEAD, 'mode': mode,
                'headStable': True, 'inputsStable': True, 'sourceMapMatchesSelectedBuild': True,
                'selectedTests': len(specs), 'groupCount': len(specs), 'selectedCaseNames': [s['name'] for s in specs],
                'runnerScriptSha256': r.legacy.sha(SOURCE), **self.selection, 'groups': groups, 'exactAllPassed': True})

    def write(self, name, obj):
        (self.root / name).write_text(json.dumps(obj))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def run_report(self):
        with patch.object(r.legacy, 'git', return_value=(HEAD + '\n').encode()), \
             patch.object(r.focused, 'source', return_value=SOURCE), \
             patch.object(r.focused, 'context', return_value=self.base):
            return r.report(REPO, '123', HEAD, '1', self.root)

    def case(self, mode='LaunchContracts', index=0):
        spec = SPECS[mode][index]
        return spec, 'git-launch-controls-' + mode + '-' + spec['name'], 'git-launch-controls-' + mode + '.result.json'

    def update_case(self, mode, index, change, update_aggregate=True):
        _, name, aggname = self.case(mode, index)
        record = self.read(name + '.result.json')
        change(record)
        self.write(name + '.result.json', record)
        if update_aggregate:
            aggregate = self.read(aggname)
            aggregate['groups'][index] = record
            self.write(aggname, aggregate)

    def assert_unverified(self, result, mode_index=0, case_index=0):
        self.assertFalse(result['allElevenVerifiedPassed'])
        self.assertEqual(result['modes'][mode_index]['cases'][case_index]['status'], 'unverified')

    def test_all_eleven_exact_raw_controls_pass(self):
        result = self.run_report()
        self.assertTrue(result['allElevenVerifiedPassed'])
        self.assertEqual([m['counts'] for m in result['modes']], [{'passed': 4}, {'passed': 7}])

    def test_missing_aggregate_keeps_raw_named_pass_unverified(self):
        (self.root / 'git-launch-controls-LaunchContracts.result.json').unlink()
        result = self.run_report()
        self.assert_unverified(result)
        self.assertEqual(result['modes'][0]['cases'][0]['terminal']['classification'], 'named_pass')

    def test_missing_raw_or_case_receipt_cannot_pass(self):
        _, name, _ = self.case()
        for suffix in ['.stdout.log', '.stderr.log', '.result.json']:
            path = self.root / (name + suffix)
            original = path.read_bytes()
            path.unlink()
            self.assert_unverified(self.run_report())
            path.write_bytes(original)

    def test_case_identity_flags_hash_and_exit_are_strict(self):
        _, name, aggname = self.case()
        original = self.read(name + '.result.json')
        aggregate = self.read(aggname)
        mutations = [('head', 'e' * 40), ('filter', 'wrong::case'), ('exactFilter', 1),
                     ('explicitIgnored', 0), ('invocationReturned', False), ('terminationRequestedByRunner', True),
                     ('stdoutSha256', '0' * 64), ('stderrSha256', '0' * 64)]
        mutations += [('exitCode', val) for val in [False, True, None, '0', '101', 101]]
        for key, val in mutations:
            with self.subTest(key=key, value=val):
                changed = copy.deepcopy(original)
                changed[key] = val
                self.write(name + '.result.json', changed)
                changed_agg = copy.deepcopy(aggregate)
                changed_agg['groups'][0] = changed
                self.write(aggname, changed_agg)
                self.assert_unverified(self.run_report())
        self.write(name + '.result.json', original)
        self.write(aggname, aggregate)

    def test_duplicate_or_truncated_summary_and_wrong_name_cannot_pass(self):
        spec, name, _ = self.case()
        for out in [text_for(spec) * 2, f"running 1 test\ntest {spec['test']} ... ",
                    text_for({'test': 'other::case'}), text_for(spec, 'ignored'),
                    'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored;\n']:
            (self.root / (name + '.stdout.log')).write_text(out)
            self.update_case('LaunchContracts', 0, lambda rec: rec.update(stdoutSha256=r.legacy.sha(out.encode())))
            self.assert_unverified(self.run_report())

    def test_settlement_requires_one_actual_exact_phase(self):
        spec, name, _ = self.case('GitSettlement')
        for err, count in [('', 0), ((spec['marker'] + '\n') * 2, 2), ('some prefix ' + spec['marker'] + '\n', 0)]:
            (self.root / (name + '.stderr.log')).write_text(err)
            self.update_case('GitSettlement', 0, lambda rec: rec.update(stderrSha256=r.legacy.sha(err.encode()), phaseMarkerMatches=count, exactPassed=False))
            self.assert_unverified(self.run_report(), 1)

    def test_source_map_change_and_context_failure_never_pass(self):
        mapname = 'git-launch-controls-LaunchContracts.inputs-after.json'
        self.write(mapname, {**self.mapping, 'extra.rs': 'f' * 64})
        self.assert_unverified(self.run_report())
        self.write(mapname, self.mapping)
        self.base['issues'] = ['original selected build identity invalid']
        self.assert_unverified(self.run_report())

    def test_aggregate_inventory_hash_typed_counts_and_truth_are_strict(self):
        name = 'git-launch-controls-LaunchContracts.result.json'
        original = self.read(name)
        for key, value in [('selectedTests', True), ('groupCount', True), ('groupCount', 3),
                           ('selectedCaseNames', []), ('headStable', 1), ('inputsStable', 1),
                           ('sourceMapMatchesSelectedBuild', False), ('runnerScriptSha256', 'f' * 64),
                           ('fixtureSha256', 'f' * 64), ('testBinarySha256', 'f' * 64),
                           ('finalHead', 'e' * 40), ('groups', []), ('exactAllPassed', False), ('exactAllPassed', 1)]:
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(original)
                changed[key] = value
                self.write(name, changed)
                self.assert_unverified(self.run_report())
        self.write(name, original)

    def test_aggregate_must_match_original_case_receipt(self):
        self.update_case('LaunchContracts', 0, lambda rec: rec.update(extra='not-in-aggregate'), False)
        self.assert_unverified(self.run_report())

    def test_actual_named_failure_is_failed_not_not_run(self):
        spec, name, aggname = self.case()
        out = text_for(spec, 'FAILED')
        (self.root / (name + '.stdout.log')).write_text(out)
        self.update_case('LaunchContracts', 0, lambda rec: rec.update(exitCode=101, exactPassed=False, stdoutSha256=r.legacy.sha(out.encode())))
        aggregate = self.read(aggname)
        aggregate['exactAllPassed'] = False
        self.write(aggname, aggregate)
        result = self.run_report()
        self.assertFalse(result['allElevenVerifiedPassed'])
        self.assertEqual(result['modes'][0]['counts'], {'failed': 1, 'passed': 3})

    def test_duplicate_json_keys_and_changed_inputs_during_read_never_pass(self):
        name = 'git-launch-controls-LaunchContracts.result.json'
        original = (self.root / name).read_text()
        (self.root / name).write_text('{"head":"other",' + original[1:])
        self.assert_unverified(self.run_report())
        (self.root / name).write_text(original)
        with patch.object(r.focused.Artifacts, 'changes', return_value=['synthetic changed file']):
            result = self.run_report()
        self.assertFalse(result['allElevenVerifiedPassed'])
        self.assertFalse(result['inputsStableDuringRead'])

    def test_exact_inventory_duplicate_or_unknown_scope_rejected(self):
        self.assertEqual([len(v) for v in SPECS.values()], [4, 7])
        with self.assertRaises(ValueError):
            r.specs(SOURCE.decode().replace("name = 'natural-tail'", "name = 'generic-command-shape'"))
        with self.assertRaises(ValueError):
            r.specs(SOURCE.decode().replace('windows_process::tests::', 'foreign::tests::'))

if __name__ == '__main__':
    unittest.main(verbosity=2)
