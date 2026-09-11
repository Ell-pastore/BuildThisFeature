import 'package:flutter/material.dart';
import '../widgets/app_status_bar.dart';
import '../widgets/confirm_sheet.dart';

/// Screen 5 — Confirmation Sheet (modal-style presentation).
class ConfirmScreen extends StatelessWidget {
  const ConfirmScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Stack(
      children: [
        Container(
          color: cs.surface,
          child: SafeArea(
            bottom: false,
            child: Column(
              children: [
                const AppStatusBar(),
                Container(
                  height: 64,
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [Color(0xFFDBEAFE), Color(0xFFEDE9FE)],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        // Dim scrim covering everything beneath the sheet.
        Positioned.fill(
          child: Container(color: const Color(0xCC141623)),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: ConfirmSheet(
            onCancel: () => Navigator.of(context).maybePop(),
            onReviewSteps: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Walk through each step first.')),
              );
            },
            onRunPlan: () {
              Navigator.of(context).maybePop();
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Running plan… (stub)')),
              );
            },
          ),
        ),
      ],
    );
  }
}
