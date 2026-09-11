import 'package:flutter/material.dart';

/// Pure-decorative status bar mirroring the design board ("9:41 + signals").
class AppStatusBar extends StatelessWidget {
  const AppStatusBar({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final fg = isDark ? Colors.white : Colors.black;
    return SizedBox(
      height: 32,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text(
              '9:41',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
            Row(children: [
              Icon(Icons.signal_cellular_alt, size: 12, color: fg),
              const SizedBox(width: 4),
              Icon(Icons.signal_wifi_4_bar,  size: 12, color: fg),
              const SizedBox(width: 4),
              Icon(Icons.battery_full,         size: 14, color: fg),
            ]),
          ],
        ),
      ),
    );
  }
}
