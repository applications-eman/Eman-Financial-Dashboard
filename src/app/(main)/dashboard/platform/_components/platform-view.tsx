"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { platformConfigured } from "@/lib/platform-api";

import { AuditTab } from "./audit-tab";
import { CustomersTab } from "./customers-tab";
import { ProductsTab } from "./products-tab";
import { SalesmenTab } from "./salesmen-tab";
import { ServicesTab } from "./services-tab";
import { SettingsTab } from "./settings-tab";

export function PlatformView() {
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">WhatsApp Platform</h1>
        <p className="text-muted-foreground text-sm">
          Connected services and numbers, salesmen, customers, products with price limits, settings and the change log.
        </p>
      </div>

      {platformConfigured() ? (
        <Tabs defaultValue="salesmen" className="gap-4">
          <TabsList className="flex-wrap">
            <TabsTrigger value="salesmen">Salesmen</TabsTrigger>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="services">Services &amp; numbers</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="audit">Change log</TabsTrigger>
          </TabsList>
          <TabsContent value="salesmen">
            <SalesmenTab />
          </TabsContent>
          <TabsContent value="customers">
            <CustomersTab />
          </TabsContent>
          <TabsContent value="products">
            <ProductsTab />
          </TabsContent>
          <TabsContent value="services">
            <ServicesTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
          <TabsContent value="audit">
            <AuditTab />
          </TabsContent>
        </Tabs>
      ) : (
        <Alert>
          <AlertDescription>
            The platform service is not connected yet. It appears here once it is deployed and its address is added to
            the dashboard settings.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
