package com.finextium.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * window.print() is a no-op inside an Android WebView. js/app-shell.js routes it here, which hands
 * the WebView to the system print sheet (print to a printer or "Save as PDF"). The page's
 * @media print styles apply, exactly like printing from the browser.
 */
@CapacitorPlugin(name = "AppPrint")
public class AppPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        final String name = call.getString("name", "Finextium");
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
                printManager.print(name, adapter,
                        new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                call.resolve();
            } catch (Exception e) {
                call.reject("Print failed", e);
            }
        });
    }
}
