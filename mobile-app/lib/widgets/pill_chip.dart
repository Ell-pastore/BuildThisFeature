import 'package:flutter/material.dart';

/// M3 pill chip with optional trailing icon and a numeric badge.
class PillChip extends StatelessWidget {
  const PillChip({
    super.key,
    required this.label,
    this.active = false,
    this.trailingIcon,
    this.badge,
  });

  final String label;
  final bool active;
  final IconData? trailingIcon;
  final int? badge;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: active ? cs.primaryContainer : Colors.transparent,
        border: Border.all(
          color: active ? Colors.transparent : cs.outline,
        ),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: active ? cs.primary : cs.onSurface.withOpacity(0.7),
            ),
          ),
          if (trailingIcon != null) ...[
            const SizedBox(width: 4),
            Icon(trailingIcon,
                size: 12,
                color: active ? cs.primary : cs.onSurface.withOpacity(0.5)),
          ],
          if (badge != null) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: cs.primaryContainer,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                '$badge',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: cs.primary,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
