import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import 'confirm_sheet.dart';

class AiChatScreen extends StatelessWidget {
  const AiChatScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface = isDark ? AppColors.darkOnSurface : AppColors.lightOnSurface;
    final onSurface2 = isDark ? AppColors.darkOnSurface2 : AppColors.lightOnSurface2;
    final bg = isDark ? AppColors.darkBg : AppColors.lightBg;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('AI Assistant', style: TextStyle(fontSize: 18)),
        actions: [
          IconButton(onPressed: () {}, icon: const Icon(Icons.delete_outline)),
        ],
      ),
      body: Column(
        children: [
          // Header
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: isDark
                    ? [
                        const Color(0xFF1E1B4B),
                        const Color(0xFF2E1065),
                      ]
                    : [
                        const Color(0xFFE8E9FF),
                        const Color(0xFFF3E8FF),
                      ],
              ),
              border: Border(bottom: BorderSide(color: outline)),
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
                        gradient: LinearGradient(
                          colors: [Color(0xFF4F46E5), Color(0xFFA855F7)],
                        ),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.auto_awesome,
                        color: Colors.white,
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'FileMind AI',
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                              color: onSurface,
                            ),
                          ),
                          const Row(
                            children: [
                              Icon(Icons.circle,
                                  size: 6, color: AppColors.success),
                              SizedBox(width: 4),
                              Text(
                                'Online · GPT-class',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.success,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      onPressed: () {},
                      icon: Icon(Icons.more_horiz, color: onSurface),
                      style: IconButton.styleFrom(
                        backgroundColor: surface,
                        side: BorderSide(color: outline),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'I can organize, search, rename, move, and clean up your files. Anything destructive needs your confirmation.',
                  style: TextStyle(
                    fontSize: 12,
                    color: onSurface2,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),

          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // User message
                Align(
                  alignment: Alignment.centerRight,
                  child: Container(
                    constraints: BoxConstraints(
                      maxWidth: MediaQuery.of(context).size.width * 0.78,
                    ),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    decoration: const BoxDecoration(
                      color: AppColors.primary,
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(16),
                        topRight: Radius.circular(4),
                        bottomLeft: Radius.circular(16),
                        bottomRight: Radius.circular(16),
                      ),
                    ),
                    child: const Text(
                      'Move all PDFs from Downloads to Documents and rename them with today\'s date.',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 12),

                // AI response
                Align(
                  alignment: Alignment.centerLeft,
                  child: Container(
                    constraints: BoxConstraints(
                      maxWidth: MediaQuery.of(context).size.width * 0.85,
                    ),
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      color: surface,
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(4),
                        topRight: Radius.circular(16),
                        bottomLeft: Radius.circular(16),
                        bottomRight: Radius.circular(16),
                      ),
                      border: Border.all(color: outline),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
                          child: Text(
                            'Found 14 PDFs in Downloads. Here\'s my plan:',
                            style: TextStyle(
                              fontSize: 12,
                              height: 1.5,
                              color: onSurface,
                            ),
                          ),
                        ),
                        Container(
                          margin: const EdgeInsets.fromLTRB(4, 0, 4, 4),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: isDark
                                ? AppColors.darkSurface2
                                : AppColors.lightBg,
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: outline),
                          ),
                          child: Column(
                            children: [
                              _PlanStep(
                                label: 'Move 14 files → Documents',
                                step: 'Step 1',
                                done: true,
                                isDark: isDark,
                              ),
                              _PlanStep(
                                label: 'Rename → prefix "2026-09-08_"',
                                step: 'Step 2',
                                pending: true,
                                isDark: isDark,
                              ),
                              _PlanStep(
                                label: 'Archive original folder to Trash',
                                step: 'Step 3',
                                isDark: isDark,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 12),

                // Suggestion chips
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      _Chip(
                        label: 'Confirm',
                        isDark: isDark,
                        onTap: () {
                          showModalBottomSheet(
                            context: context,
                            isScrollControlled: true,
                            backgroundColor: Colors.transparent,
                            builder: (_) => const ConfirmSheet(),
                          );
                        },
                      ),
                      _Chip(label: 'Edit step', isDark: isDark),
                      _Chip(label: 'Skip step 3', isDark: isDark),
                    ],
                  ),
                ),
              ],
            ),
          ),

          // Input
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            decoration: BoxDecoration(
              color: bg,
              border: Border(top: BorderSide(color: outline)),
            ),
            child: SafeArea(
              child: Row(
                children: [
                  IconButton(
                    onPressed: () {},
                    icon: Icon(Icons.add, color: onSurface),
                  ),
                  Expanded(
                    child: TextField(
                      style: TextStyle(fontSize: 12, color: onSurface),
                      decoration: InputDecoration(
                        hintText: 'Ask about your files…',
                        hintStyle: TextStyle(color: onSurface2),
                        filled: true,
                        fillColor: surface,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(99),
                          borderSide: BorderSide(color: outline),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(99),
                          borderSide: BorderSide(color: outline),
                        ),
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
                    child: const Icon(
                      Icons.send,
                      color: Colors.white,
                      size: 18,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanStep extends StatelessWidget {
  final String label;
  final String step;
  final bool done;
  final bool pending;
  final bool isDark;

  const _PlanStep({
    required this.label,
    required this.step,
    this.done = false,
    this.pending = false,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    Color dotColor = isDark ? AppColors.darkOnSurface2 : const Color(0xFF8E92A0);
    if (done) dotColor = AppColors.success;
    if (pending) dotColor = AppColors.warning;
    if (!done && !pending) {
      dotColor = isDark ? AppColors.darkPrimary : AppColors.primary;
    }

    final onSurface = isDark ? AppColors.darkOnSurface : AppColors.lightOnSurface;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: TextStyle(fontSize: 12, color: onSurface),
            ),
          ),
          Text(
            step,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: done
                  ? (isDark ? AppColors.darkPrimary : AppColors.primary)
                  : (pending
                      ? AppColors.warning
                      : (isDark
                          ? AppColors.darkOnSurface2
                          : const Color(0xFF8E92A0))),
            ),
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final bool isDark;
  final VoidCallback? onTap;

  const _Chip({
    required this.label,
    required this.isDark,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(right: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: surface,
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: outline),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w500,
            color: isDark ? AppColors.darkPrimary : AppColors.primary,
          ),
        ),
      ),
    );
  }
}
