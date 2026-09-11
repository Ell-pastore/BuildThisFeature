import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';

/// Screen 4 — AI Assistant · Plan Preview.
class AiChatScreen extends StatelessWidget {
  const AiChatScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      color: cs.surface,
      child: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const AppStatusBar(),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    icon: const Icon(Icons.arrow_back),
                  ),
                  const Expanded(
                    child: Text(
                      'AI Assistant',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                    ),
                  ),
                  IconButton(onPressed: () {}, icon: const Icon(Icons.delete_outline)),
                ],
              ),
            ),
            _AssistantHeader(cs: cs),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                children: const [
                  _UserBubble(
                    text:
                        "Move all PDFs from Downloads to Documents and rename them with today's date.",
                  ),
                  SizedBox(height: 12),
                  _AiPlanBubble(),
                ],
              ),
            ),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Row(
                children: const [
                  _ChipPill(label: 'Confirm'),
                  SizedBox(width: 6),
                  _ChipPill(label: 'Edit step'),
                  SizedBox(width: 6),
                  _ChipPill(label: 'Skip step 3'),
                ],
              ),
            ),
            const _ChatInputBar(),
          ],
        ),
      ),
    );
  }
}

class _AssistantHeader extends StatelessWidget {
  const _AssistantHeader({required this.cs});
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFFE8E9FF), Color(0xFFF3E8FF)],
        ),
        border: Border(bottom: BorderSide(color: cs.outline)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(
                    colors: [Color(0xFF4F46E5), Color(0xFFA855F7)],
                  ),
                ),
                child: const Icon(Icons.auto_awesome, color: Colors.white, size: 20),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('FileMind AI',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                    SizedBox(height: 2),
                    Row(
                      children: [
                        _OnlineDot(),
                        SizedBox(width: 4),
                        Text('Online · GPT-class',
                            style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: AppColors.success)),
                      ],
                    ),
                  ],
                ),
              ),
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: cs.outline),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: const Icon(Icons.more_horiz, size: 16, color: Colors.black),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'I can organize, search, rename, move, and clean up your files.\n'
            'Anything destructive needs your confirmation.',
            style: TextStyle(
                fontSize: 12,
                color: cs.onSurface.withOpacity(0.7),
                height: 1.5),
          ),
        ],
      ),
    );
  }
}

class _OnlineDot extends StatelessWidget {
  const _OnlineDot();
  @override
  Widget build(BuildContext context) => Container(
        width: 6,
        height: 6,
        decoration: const BoxDecoration(color: AppColors.success, shape: BoxShape.circle),
      );
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 280),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: const BoxDecoration(
          color: AppColors.primary,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(4),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Text(text,
            style: const TextStyle(fontSize: 12, color: Colors.white, height: 1.5)),
      ),
    );
  }
}

class _AiPlanBubble extends StatelessWidget {
  const _AiPlanBubble();

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 320),
        decoration: BoxDecoration(
          color: cs.surface,
          border: Border.all(color: cs.outline),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          ),
        ),
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            RichText(
              text: TextSpan(
                style: TextStyle(fontSize: 13, color: cs.onSurface),
                children: const [
                  TextSpan(text: 'Found '),
                  TextSpan(
                      text: '14 PDFs',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  TextSpan(text: " in Downloads. Here's my plan:"),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                border: Border.all(color: cs.outline),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Column(
                children: [
                  _PlanItem(label: 'Move 14 files → Documents',        state: _PlanState.current),
                  _PlanItem(label: 'Rename → prefix "2026-09-08_"',    state: _PlanState.pending),
                  _PlanItem(label: 'Archive original folder to Trash', state: _PlanState.pending, last: true),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

enum _PlanState { current, pending, done }

class _PlanItem extends StatelessWidget {
  const _PlanItem({
    required this.label,
    required this.state,
    this.last = false,
  });
  final String     label;
  final _PlanState state;
  final bool       last;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    Color dot;
    switch (state) {
      case _PlanState.current:
        dot = cs.primary;
        break;
      case _PlanState.done:
        dot = AppColors.success;
        break;
      case _PlanState.pending:
        dot = AppColors.warning;
        break;
    }
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        border: last ? const Border() : Border(bottom: BorderSide(color: cs.outline)),
      ),
      child: Row(
        children: [
          Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }
}

class _ChipPill extends StatelessWidget {
  const _ChipPill({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label,
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: cs.primary)),
    );
  }
}

class _ChatInputBar extends StatelessWidget {
  const _ChatInputBar();

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border(top: BorderSide(color: cs.outline)),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      child: Row(
        children: [
          Icon(Icons.add, size: 20, color: cs.onSurface),
          const SizedBox(width: 8),
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                border: Border.all(color: cs.outline),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                'Ask about your files…',
                style: TextStyle(
                    fontSize: 12, color: cs.onSurface.withOpacity(0.45)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            width: 40,
            height: 40,
            decoration: const BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.send, size: 18, color: Colors.white),
          ),
        ],
      ),
    );
  }
}
