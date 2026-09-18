import 'package:google_generative_ai/google_generative_ai.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

class GeminiService {
  late final GenerativeModel _model;
  late final ChatSession _chat;

  GeminiService() {
    final apiKey = dotenv.env['GEMINI_API_KEY'] ?? '';
    if (apiKey.isEmpty) {
      throw Exception('GEMINI_API_KEY is missing. Add it to your .env file.');
    }

    _model = GenerativeModel(
      model: 'gemini-3.6-flash',
      apiKey: apiKey,
      systemInstruction: Content.system(
        '''You are FileMind AI, a helpful assistant inside a mobile file manager app.
    You help users organize, search, rename, move, and clean up files.
    Be concise and practical.
    If the user asks for a destructive action (delete, move many files, etc.),
    propose a clear step-by-step plan and ask for confirmation before acting.''',
      ),
    );

    _chat = _model.startChat();
  }

  /// Send a user message and get the assistant reply
  Future<String> sendMessage(String userMessage) async {
    final response = await _chat.sendMessage(Content.text(userMessage));
    return response.text ?? 'No response from Gemini.';
  }

  /// Clear conversation history
  void clear() {
    _chat = _model.startChat();
  }
}
