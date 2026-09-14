import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/common_widgets.dart';

class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface2 = isDark ? AppColors.darkOnSurface2 : const Color(0xFF8E92A0);
    final onSurface = isDark ? AppColors.darkOnSurface : AppColors.lightOnSurface;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Search', style: TextStyle(fontSize: 18)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 100),
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: outline),
            ),
            child: Row(
              children: [
                Icon(Icons.search, size: 18, color: onSurface2),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'tax 2024',
                    style: TextStyle(fontSize: 13, color: onSurface),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'AI understood: tax-related PDFs from 2024',
            style: TextStyle(fontSize: 11, color: onSurface2),
          ),
          const SizedBox(height: 14),

          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              _FilterChip(label: 'PDF', count: '12', isDark: isDark),
              _FilterChip(label: '2024', count: '8', isDark: isDark),
              _FilterChip(label: 'Documents', count: '12', isDark: isDark),
              _FilterChip(label: 'Images', count: '4', isDark: isDark),
            ],
          ),

          const SizedBox(height: 16),

          _ResultCard(
            name: 'Tax-Returns-2024.pdf',
            meta: 'Documents · 4.2 MB · Apr 12, 2024',
            type: 'PDF',
            match: '"Tax Return Form 1040 — filed for year 2024. Contains W-2 ..."',
            starred: true,
            isDark: isDark,
          ),
          _ResultCard(
            name: 'State-Taxes-CA-2024.pdf',
            meta: 'Documents · 1.8 MB · Mar 28, 2024',
            type: 'PDF',
            match: '"Taxes for California — filed in 2024. Schedule C attached."',
            isDark: isDark,
          ),
          _ResultCard(
            name: 'Tax-Notes-Misc.docx',
            meta: 'Downloads · 86 KB · Dec 14, 2024',
            type: 'DOC',
            match: '"Notes about tax deductions for 2024 filing."',
            isDark: isDark,
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final String count;
  final bool isDark;

  const _FilterChip({
    required this.label,
    required this.count,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface = isDark ? AppColors.darkOnSurface : AppColors.lightOnSurface;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: surface,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: outline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: onSurface,
            ),
          ),
          const SizedBox(width: 4),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: isDark
                  ? AppColors.darkPrimary.withValues(alpha: 0.2)
                  : AppColors.primaryContainer,
              borderRadius: BorderRadius.circular(99),
            ),
            child: Text(
              count,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: isDark ? AppColors.darkPrimary : AppColors.primary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  final String name, meta, type, match;
  final bool starred;
  final bool isDark;

  const _ResultCard({
    required this.name,
    required this.meta,
    required this.type,
    required this.match,
    this.starred = false,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface = isDark ? AppColors.darkOnSurface : AppColors.lightOnSurface;
    final onSurface2 = isDark ? AppColors.darkOnSurface2 : AppColors.lightOnSurface2;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: outline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              FileTypeIcon(type: type, size: 36),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: onSurface,
                      ),
                    ),
                    Text(
                      meta,
                      style: TextStyle(fontSize: 11, color: onSurface2),
                    ),
                  ],
                ),
              ),
              Icon(
                starred ? Icons.star : Icons.star_border,
                color: starred
                    ? (isDark ? AppColors.darkPrimary : AppColors.primary)
                    : onSurface2,
                size: 20,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Divider(height: 1, color: outline),
          const SizedBox(height: 8),
          Text(
            match,
            style: TextStyle(fontSize: 11, color: onSurface2),
          ),
        ],
      ),
    );
  }
}
