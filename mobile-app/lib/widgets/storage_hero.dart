import 'package:flutter/material.dart';

/// One colored + width-value segment of the storage bar. Widths must sum to 1.
class StorageSegment {
  const StorageSegment(this.width, this.color);
  final double width;
  final Color  color;
}

/// Hero storage card with gradient background, large total + segmented bar
/// + legend. Identical layout to Screen 1 and Screen 8 (light / dark variants
/// supplied via [gradientColors]).
class StorageHero extends StatelessWidget {
  const StorageHero({
    super.key,
    required this.usedGb,
    required this.totalGb,
    required this.freeGb,
    required this.segments,
    required this.legend,
    this.gradientColors = const [
      Color(0xFF4F46E5),
      Color(0xFF7C3AED),
      Color(0xFFEC4899),
    ],
  });

  final double usedGb;
  final double totalGb;
  final double freeGb;
  final List<StorageSegment> segments;
  final List<({Color color, String label})> legend;
  final List<Color> gradientColors;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: gradientColors,
        ),
        boxShadow: const [
          BoxShadow(color: Color(0x1A4F46E5), blurRadius: 24, offset: Offset(0, 8)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'STORAGE',
            style: TextStyle(
              fontSize: 13,
              color: Colors.white,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.4,
            ),
          ),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                usedGb.toStringAsFixed(1),
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(width: 6),
              const Text(
                'GB used',
                style: TextStyle(
                  fontSize: 18,
                  color: Colors.white,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          Text(
            'of ${totalGb.toStringAsFixed(0)} GB · ${freeGb.toStringAsFixed(1)} GB free',
            style: const TextStyle(fontSize: 12, color: Colors.white),
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: SizedBox(
              height: 8,
              child: Row(
                children: [
                  for (final s in segments)
                    Expanded(
                      flex: (s.width * 1000).round(),
                      child: Container(color: s.color),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 16,
            runSpacing: 6,
            children: [
              for (final l in legend)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: l.color,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(l.label,
                        style: const TextStyle(fontSize: 11, color: Colors.white)),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }
}
