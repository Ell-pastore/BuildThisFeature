import 'package:flutter/material.dart';

/// Inline AI suggestion card used on the home screen.
/// Has a gradient orb on the left and a single sentence with a bolded
/// leading prefix (e.g. "Tip:").
class AiInsightCard extends StatelessWidget {
  const AiInsightCard({
    super.key,
    required this.prefix,
    required this.body,
  });

  final String prefix;
  final String body;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.primary, width: 1.2),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                colors: [Color(0xFF4F46E5), Color(0xFFA855F7)],
              ),
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 16),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: TextStyle(
                  fontSize: 12,
                  color: cs.onSurface.withOpacity(0.7),
                  height: 1.4,
                ),
                children: [
                  TextSpan(
                    text: prefix,
                    style: TextStyle(
                      color: cs.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  TextSpan(text: ' $body'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
