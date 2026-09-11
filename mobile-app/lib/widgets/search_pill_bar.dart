import 'package:flutter/material.dart';

/// Search field wrapped in a rounded surface (Material 3 outlined style).
/// Use either [placeholder] (placeholder text) or [value] (static pre-filled value).
class SearchPillBar extends StatelessWidget {
  const SearchPillBar({
    super.key,
    this.placeholder,
    this.value,
    this.controller,
    this.onChanged,
  });

  final String? placeholder;
  final String? value;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(Icons.search,
              size: 16, color: cs.onSurface.withOpacity(0.45)),
          const SizedBox(width: 8),
          Expanded(
            child: value != null
                ? Text(
                    value!,
                    style: const TextStyle(fontSize: 13),
                  )
                : TextField(
                    controller: controller,
                    onChanged: onChanged,
                    decoration: InputDecoration(
                      isCollapsed: true,
                      border: InputBorder.none,
                      hintText: placeholder,
                      hintStyle: TextStyle(
                        fontSize: 13,
                        color: cs.onSurface.withOpacity(0.45),
                      ),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
          ),
        ],
      ),
    );
  }
}
