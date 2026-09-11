import 'package:flutter/material.dart';
import '../theme/app_colors.dart';

/// Draggable confirmation sheet — Screen 5.
/// Reusable from any "triggered an AI plan" flow.
class ConfirmSheet extends StatelessWidget {
  const ConfirmSheet({
    super.key,
    required this.onRunPlan,
    required this.onCancel,
    required this.onReviewSteps,
  });

  final VoidCallback onRunPlan;
  final VoidCallback onCancel;
  final VoidCallback onReviewSteps;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return DraggableScrollableSheet(
      initialChildSize: 0.78,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, scroll) => Container(
        decoration: BoxDecoration(
          color: cs.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
        ),
        child: ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: cs.outline,
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Confirm action plan',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              'FileMind AI · Review before executing',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 11,
                color: cs.onSurface.withOpacity(0.55),
              ),
            ),
            const SizedBox(height: 14),
            const _SummaryCard(),
            const SizedBox(height: 12),
            const _FilePillsRow(),
            const SizedBox(height: 8),
            const _ToggleRow(label: 'Move originals to Trash after copy', initial: true),
            const _ToggleRow(label: 'Allow undo for 24h',                  initial: true),
            const _ToggleRow(label: 'Notify me when done',                 initial: false),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                  onPressed: onCancel,
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                  onPressed: onReviewSteps,
                  child: const Text('Review step-by-step'),
                ),
              ),
            ]),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.success,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
                ),
                onPressed: onRunPlan,
                child: const Text('Run plan (14 files)'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard();

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    Widget row(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(k,
                  style: TextStyle(
                      fontSize: 12,
                      color: cs.onSurface.withOpacity(0.7))),
              Text(v, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ],
          ),
        );
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        children: [
          row('Operation',      'Move + Rename'),
          row('Files affected', '14 PDFs'),
          row('Source',         '/Downloads'),
          row('Destination',    '/Documents'),
          row('Estimated time', '~6 seconds'),
        ],
      ),
    );
  }
}

class _FilePillsRow extends StatelessWidget {
  const _FilePillsRow();

  Widget _pill(BuildContext context, String label) {
    final cs = Theme.of(context).colorScheme;
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          border: Border.all(color: cs.outline),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                color: AppColors.pdfRed,
                borderRadius: BorderRadius.circular(6),
              ),
              alignment: Alignment.center,
              child: const Text(
                'PDF',
                style: TextStyle(
                    fontSize: 9, fontWeight: FontWeight.w700, color: Colors.white),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Row(
      children: [
        _pill(context, 'Invoice-Mar.pdf'),
        const SizedBox(width: 6),
        _pill(context, 'Contract.pdf'),
        const SizedBox(width: 6),
        Container(
          width: 60,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: cs.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
          ),
          alignment: Alignment.center,
          child: const Text('+12',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
        ),
      ],
    );
  }
}

class _ToggleRow extends StatefulWidget {
  const _ToggleRow({required this.label, required this.initial});
  final String label;
  final bool   initial;

  @override
  State<_ToggleRow> createState() => _ToggleRowState();
}

class _ToggleRowState extends State<_ToggleRow> {
  late bool on = widget.initial;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(child: Text(widget.label, style: const TextStyle(fontSize: 13))),
          Switch(value: on, onChanged: (v) => setState(() => on = v)),
        ],
      ),
    );
  }
}
