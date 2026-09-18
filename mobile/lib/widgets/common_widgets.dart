import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/dummy_data.dart';

class FileTypeIcon extends StatelessWidget {
  final String type;
  final double size;

  const FileTypeIcon({super.key, required this.type, this.size = 40});

  Color get _bg {
    switch (type) {
      case 'PDF':
        return const Color(0xFFEF4444);
      case 'IMG':
        return const Color(0xFF22C55E);
      case 'DOC':
        return const Color(0xFF3B82F6);
      case 'XLS':
        return const Color(0xFF22C55E);
      case 'PPT':
        return const Color(0xFFA855F7);
      default:
        return AppColors.primary;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: _bg,
        borderRadius: BorderRadius.circular(10),
      ),
      alignment: Alignment.center,
      child: Text(
        type,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.28,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class FileRow extends StatelessWidget {
  final FileItem file;
  final bool showCheckbox;
  final VoidCallback? onTap;

  const FileRow({
    super.key,
    required this.file,
    this.showCheckbox = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Row(
          children: [
            FileTypeIcon(type: file.type),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    file.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: file.selected
                          ? AppColors.primary
                          : (isDark
                              ? AppColors.darkOnSurface
                              : AppColors.lightOnSurface),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    file.meta,
                    style: TextStyle(
                      fontSize: 11,
                      color: isDark
                          ? AppColors.darkOnSurface2
                          : const Color(0xFF8E92A0),
                    ),
                  ),
                ],
              ),
            ),
            if (showCheckbox)
              Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: file.selected ? AppColors.primary : Colors.transparent,
                  border: Border.all(
                    color: file.selected
                        ? AppColors.primary
                        : const Color(0xFF8E92A0),
                    width: 2,
                  ),
                ),
                child: file.selected
                    ? const Icon(Icons.check, size: 14, color: Colors.white)
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}

class SectionHeader extends StatelessWidget {
  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  const SectionHeader({
    super.key,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 18, bottom: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            title,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
          if (actionLabel != null)
            GestureDetector(
              onTap: onAction,
              child: Text(
                actionLabel!,
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: AppColors.primary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
